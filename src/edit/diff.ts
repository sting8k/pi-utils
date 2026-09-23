/**
 * Self-written diff for the edit override (US-003): line-level hunks with a
 * compact render, plus a small unified-patch emitter for the `patch` detail.
 * No `git diff` / `diff -u` subprocess — no git anywhere (owner decision):
 * identical behavior in git and non-git directories.
 */

export const CONTEXT_LINES = 5;

export type EditDiff = {
	oldStart: number;
	newStart: number;
	oldLines: string[];
	newLines: string[];
};

export type ContextRange = {
	startIndex: number;
	endIndex: number;
};

export function formatContexts(
	lines: string[],
	ranges: ContextRange[],
): string {
	const ordered = ranges
		.filter((range) => range.startIndex < range.endIndex)
		.sort((a, b) => a.startIndex - b.startIndex);
	const merged: ContextRange[] = [];

	for (const range of ordered) {
		const previous = merged.at(-1);
		if (previous && range.startIndex <= previous.endIndex) {
			previous.endIndex = Math.max(previous.endIndex, range.endIndex);
		} else {
			merged.push({ ...range });
		}
	}

	const width = String(lines.length).length;
	return merged
		.map((range) =>
			lines
				.slice(range.startIndex, range.endIndex)
				.map(
					(line, index) =>
						`${String(range.startIndex + index + 1).padStart(width, " ")}| ${line}`,
				)
				.join("\n"),
		)
		.join("\n---\n");
}

/** Render hunks under a `── title ──` header (the file path for edit results). */
export function formatDiffs(diffs: EditDiff[], title = "diff"): string {
	if (diffs.length === 0) return "";
	const chunks: string[] = [`── ${title} ──`];

	for (const diff of diffs) {
		// Headers use post-edit (new-file) coordinates.
		if (diff.newLines.length <= 1) {
			chunks.push(`:${diff.newStart}`);
		} else {
			chunks.push(
				`:${diff.newStart}-${diff.newStart + diff.newLines.length - 1}`,
			);
		}

		for (let i = 0; i < diff.oldLines.length; i++) {
			const line = diff.oldLines[i];
			chunks.push(`- ${line}`);
		}
		for (let i = 0; i < diff.newLines.length; i++) {
			const line = diff.newLines[i];
			chunks.push(`+ ${line}`);
		}
		chunks.push("");
	}

	return chunks.join("\n").trimEnd();
}

type LineOp =
	| { type: "same"; line: string }
	| { type: "del"; line: string }
	| { type: "add"; line: string };

const MAX_LCS_CELLS = 4_000_000;

/**
 * Line-level diff ops for two contents. Common prefix/suffix is trimmed
 * first; the middle goes through an LCS DP when small enough, otherwise it
 * degrades to one full replace block (correct, just not minimal).
 */
/**
 * Split into diff lines; a single trailing "" (newline terminator artifact)
 * is dropped so an empty file is [] and a final newline is not a change.
 */
function splitDiffLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function lineOps(oldContent: string, newContent: string): LineOp[] {
	const a = splitDiffLines(oldContent);
	const b = splitDiffLines(newContent);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const ops: LineOp[] = [];
	for (const line of a.slice(0, start)) ops.push({ type: "same", line });

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA.length * midB.length <= MAX_LCS_CELLS) {
		ops.push(...lcsOps(midA, midB));
	} else {
		for (const line of midA) ops.push({ type: "del", line });
		for (const line of midB) ops.push({ type: "add", line });
	}

	for (const line of a.slice(endA)) ops.push({ type: "same", line });
	return ops;
}

function lcsOps(a: string[], b: string[]): LineOp[] {
	if (a.length === 0 && b.length === 0) return [];
	if (a.length === 0) return b.map((line) => ({ type: "add" as const, line }));
	if (b.length === 0) return a.map((line) => ({ type: "del" as const, line }));

	// dp[i][j] = LCS length of a[i..] and b[j..]
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dp = new Int32Array(rows * cols);
	const dpAt = (r: number, c: number): number => dp[r * cols + c] ?? 0;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			dp[i * cols + j] =
				a[i] === b[j]
					? dpAt(i + 1, j + 1) + 1
					: Math.max(dpAt(i + 1, j), dpAt(i, j + 1));
		}
	}

	const ops: LineOp[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const lineA = a[i];
		const lineB = b[j];
		if (lineA === undefined || lineB === undefined) break;
		if (lineA === lineB) {
			ops.push({ type: "same", line: lineA });
			i++;
			j++;
		} else if (dpAt(i + 1, j) >= dpAt(i, j + 1)) {
			ops.push({ type: "del", line: lineA });
			i++;
		} else {
			ops.push({ type: "add", line: lineB });
			j++;
		}
	}
	for (const line of a.slice(i)) ops.push({ type: "del", line });
	for (const line of b.slice(j)) ops.push({ type: "add", line });
	return ops;
}

/** Changed-line hunks (1-based starts, no context lines) between two contents. */
export function diffHunks(oldContent: string, newContent: string): EditDiff[] {
	const ops = lineOps(oldContent, newContent);
	const hunks: EditDiff[] = [];
	let hunk: EditDiff | null = null;
	let oldLine = 1;
	let newLine = 1;

	for (const op of ops) {
		if (op.type === "same") {
			hunk = null;
			oldLine++;
			newLine++;
			continue;
		}
		if (hunk === null) {
			hunk = {
				oldStart: oldLine,
				newStart: newLine,
				oldLines: [],
				newLines: [],
			};
			hunks.push(hunk);
		}
		if (op.type === "del") {
			hunk.oldLines.push(op.line);
			oldLine++;
		} else {
			hunk.newLines.push(op.line);
			newLine++;
		}
	}
	return hunks;
}

export function countChanges(diffs: EditDiff[]): {
	additions: number;
	removals: number;
} {
	let additions = 0;
	let removals = 0;
	for (const diff of diffs) {
		additions += diff.newLines.length;
		removals += diff.oldLines.length;
	}
	return { additions, removals };
}

/**
 * Unified patch across files: per-file `---`/`+++` headers and `@@` hunks
 * (with `contextLines` context lines, neighboring hunks merged), concatenated
 * for multi-file. Returns "" when nothing changed.
 */
export function unifiedPatch(
	files: Array<{ path: string; oldContent: string; newContent: string }>,
	contextLines = 3,
): string {
	const blocks: string[] = [];
	for (const file of files) {
		const body = patchBody(file, contextLines);
		if (body !== "") {
			blocks.push(`--- a/${file.path}\n+++ b/${file.path}\n${body}`);
		}
	}
	return blocks.join("\n");
}

function patchBody(
	file: { path: string; oldContent: string; newContent: string },
	contextLines: number,
): string {
	const ops = lineOps(file.oldContent, file.newContent);

	// Changed op indices, then groups expanded by context and merged on overlap.
	const changed: number[] = [];
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op !== undefined && op.type !== "same") changed.push(i);
	}
	if (changed.length === 0) return "";

	const groups: Array<{ first: number; last: number }> = [];
	for (const index of changed) {
		const previous = groups.at(-1);
		if (previous && index <= previous.last + 2 * contextLines) {
			previous.last = index;
		} else {
			groups.push({ first: index, last: index });
		}
	}

	const lines: string[] = [];
	for (const group of groups) {
		const first = Math.max(0, group.first - contextLines);
		const last = Math.min(ops.length - 1, group.last + contextLines);

		let oldStart = 0;
		let newStart = 0;
		let oldCount = 0;
		let newCount = 0;
		for (let i = first; i <= last; i++) {
			const op = ops[i];
			if (op === undefined) continue;
			if (op.type !== "add") oldCount++;
			if (op.type !== "del") newCount++;
		}
		// 1-based starts: lines consumed before the group, +1. An add as the
		// first op still starts the old side at the next old line (unified
		// convention); an empty side uses the 0 sentinel.
		let oldPos = 1;
		let newPos = 1;
		for (let i = 0; i < first; i++) {
			const op = ops[i];
			if (op === undefined) continue;
			if (op.type !== "add") oldPos++;
			if (op.type !== "del") newPos++;
		}
		oldStart = oldCount === 0 ? 0 : oldPos;
		newStart = newCount === 0 ? 0 : newPos;

		lines.push(
			`@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`,
		);
		for (let i = first; i <= last; i++) {
			const op = ops[i];
			if (op === undefined) continue;
			const marker = op.type === "del" ? "-" : op.type === "add" ? "+" : " ";
			lines.push(`${marker}${op.line}`);
		}
	}
	return lines.join("\n");
}
