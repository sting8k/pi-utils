/**
 * US-004 — skill_write ops: create / patch / delete on SKILL.md files under
 * the native skills root. Every mutation follows the US-003 snapshot
 * discipline: snapshot → write → verify; any failure restores the snapshot
 * and the caller gets a fixable error. `skill_write` guards SKILL.md only —
 * supporting files (references/ etc.) are generic-file-tool territory.
 *
 * Path safety comes from the name/category regex (no separators, no dots),
 * so `join` can never escape the skills root.
 *
 * No pi imports. fs is injectable where tests need it; otherwise direct.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { snapshotPaths } from "../edit/snapshot.ts";
import {
	SKILL_NAME_MAX,
	SKILL_NAME_RE,
	validateCreate,
} from "./frontmatter.ts";

export const SKILL_MD = "SKILL.md";

export type OpResult =
	| { ok: true; path: string; warnings: string[]; extra?: string[] }
	| {
			ok: false;
			error: string;
			rolledBack: boolean;
			restoreFailures?: string[];
	  };

export interface SkillTarget {
	skillsRoot: string;
	name: string;
	category?: string;
}

/** Validate a skill name (all ops) / category (create) at the funnel. */
export function validateTarget(target: {
	name: string;
	category?: string;
}): string | null {
	if (!SKILL_NAME_RE.test(target.name) || target.name.length > SKILL_NAME_MAX) {
		return `skill name "${target.name}" invalid — must match ^[a-z0-9][a-z0-9_-]*$ (≤${SKILL_NAME_MAX} chars)`;
	}
	if (target.category !== undefined && !SKILL_NAME_RE.test(target.category)) {
		return `category "${target.category}" invalid — a single directory name matching ^[a-z0-9][a-z0-9_-]*$`;
	}
	return null;
}

/** Directory of a skill: `<skillsRoot>/[<category>/]<name>`. */
export function skillDir(target: SkillTarget): string {
	return join(
		target.skillsRoot,
		...(target.category ? [target.category] : []),
		target.name,
	);
}

/** Restore parent dirs first — snapshotPaths restores files, not dirs. */
function restoreSnapshot(
	entries: ReturnType<typeof snapshotPaths>["entries"],
): string[] {
	const failed: string[] = [];
	for (const entry of entries) {
		try {
			if (entry.present && entry.content !== null) {
				mkdirSync(dirname(entry.path), { recursive: true });
				writeFileSync(entry.path, entry.content);
			} else if (!entry.present) {
				rmSync(entry.path, { force: true });
			}
		} catch {
			failed.push(entry.path);
		}
	}
	return failed;
}

/** create: `<skillsRoot>/[<category>/]<name>/SKILL.md`. Exists → error naming patch. */
export function createSkill(target: SkillTarget, content: string): OpResult {
	const targetError = validateTarget(target);
	if (targetError) return { ok: false, error: targetError, rolledBack: false };

	const validation = validateCreate(content, target.category);
	if (validation.errors.length > 0) {
		return {
			ok: false,
			error: `invalid SKILL.md content — ${validation.errors.join("; ")}`,
			rolledBack: false,
		};
	}

	const dir = skillDir(target);
	const path = join(dir, SKILL_MD);
	if (existsSync(path)) {
		return {
			ok: false,
			error: `skill already exists at ${path} — use action:"patch" to modify it`,
			rolledBack: false,
		};
	}

	// Snapshot the (absent) target so a failed write can be undone.
	const snapshot = snapshotPaths([path]);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, content);
		// Verify: read-back must equal what we meant to write.
		const readBack = readFileSync(path);
		if (!readBack.equals(Buffer.from(content, "utf8"))) {
			throw new Error("read-back mismatch");
		}
		return { ok: true, path, warnings: validation.warnings };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed = restoreSnapshot(snapshot.entries);
		return {
			ok: false,
			error: `create failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/**
 * Patch fuzzy-match semantics: exact match first; on miss, retry against the
 * fuzzy-normalized view (trailing whitespace stripped per line, smart
 * quotes/dashes/special spaces → ASCII — same progression as pi's core edit).
 * A fuzzy hit rewrites the normalized view back (fine for our LF-authored
 * markdown; content is otherwise identical).
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function replaceAllOccurrences(
	haystack: string,
	needle: string,
	replacement: string,
): string {
	return haystack.split(needle).join(replacement);
}

/** patch: old_string → new_string on SKILL.md (fuzzy fallback, replace_all opt). */
export function patchSkill(
	skillMdPath: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): OpResult {
	if (oldString.length === 0) {
		return {
			ok: false,
			error: "old_string is empty — pass the text to replace",
			rolledBack: false,
		};
	}
	let content: string;
	try {
		content = readFileSync(skillMdPath, "utf8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `cannot read ${skillMdPath}: ${message}`,
			rolledBack: false,
		};
	}

	let base = content;
	let search = oldString;
	let usedFuzzy = false;
	let occurrences = countOccurrences(base, search);
	if (occurrences === 0) {
		base = normalizeForFuzzyMatch(content);
		search = normalizeForFuzzyMatch(oldString);
		usedFuzzy = true;
		occurrences = countOccurrences(base, search);
	}
	if (occurrences === 0) {
		return {
			ok: false,
			error: `old_string not found in ${SKILL_MD} — read the skill and copy the text exactly`,
			rolledBack: false,
		};
	}
	if (occurrences > 1 && !replaceAll) {
		return {
			ok: false,
			error: `old_string matches ${occurrences} locations — make it unique or pass replace_all:true`,
			rolledBack: false,
		};
	}
	const updated = replaceAllOccurrences(base, search, newString);
	if (updated === base) {
		return {
			ok: false,
			error: "old_string equals new_string — nothing to change",
			rolledBack: false,
		};
	}

	const snapshot = snapshotPaths([skillMdPath]);
	try {
		writeFileSync(skillMdPath, updated);
		const readBack = readFileSync(skillMdPath, "utf8");
		if (readBack !== updated) throw new Error("read-back mismatch");
		return {
			ok: true,
			path: skillMdPath,
			warnings: usedFuzzy
				? ["old_string matched after fuzzy normalization (whitespace/quotes)"]
				: [],
			extra: [`${occurrences} replacement${occurrences > 1 ? "s" : ""}`],
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed = restoreSnapshot(snapshot.entries);
		return {
			ok: false,
			error: `patch failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back to snapshot"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/** Collect every file under dir (recursive). */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

/** delete: remove the skill dir; every file snapshot-restorable on failure. */
export function deleteSkill(skillDirectory: string): OpResult {
	if (!existsSync(skillDirectory)) {
		return {
			ok: false,
			error: `no skill directory at ${skillDirectory} — nothing to delete`,
			rolledBack: false,
		};
	}
	const files = listFiles(skillDirectory);
	if (files.length === 0) {
		return {
			ok: false,
			error: `${skillDirectory} contains no files — not a skill; refusing to blind-delete`,
			rolledBack: false,
		};
	}
	if (
		!files.some(
			(file) =>
				file.endsWith(`/${SKILL_MD}`) ||
				file === join(skillDirectory, SKILL_MD),
		)
	) {
		return {
			ok: false,
			error: `no ${SKILL_MD} in ${skillDirectory} — not a skill; refusing to delete`,
			rolledBack: false,
		};
	}

	const snapshot = snapshotPaths(files);
	try {
		rmSync(skillDirectory, { recursive: true });
		if (existsSync(skillDirectory))
			throw new Error("directory still present after delete");
		return { ok: true, path: skillDirectory, warnings: [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed = restoreSnapshot(snapshot.entries);
		return {
			ok: false,
			error: `delete failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/**
 * Resolve a read-tool path to a SKILL.md under skillsRoot — null when the
 * path is not a SKILL.md or lies outside the root (the seen-map keys on
 * these; the guard and the index "recently-used" check share it).
 */
export function resolveSkillMdPath(
	path: string,
	skillsRoot: string,
	cwd: string,
): string | null {
	const absolute = isAbsolute(path) ? path : join(cwd, path);
	if (absolute.split("/").pop() !== SKILL_MD) return null;
	const rel = relative(skillsRoot, absolute);
	if (rel.length === 0 || rel.startsWith("..")) return null;
	return absolute;
}
