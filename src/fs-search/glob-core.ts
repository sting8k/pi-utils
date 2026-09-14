/**
 * glob tool core — file discovery by name (dsh semantics, pi machinery).
 *
 * rg --files with --hidden and --no-ignore (gitignored files ARE results —
 * that is the point), VCS metadata excluded. Patterns without "/" match the
 * basename at any depth (rg/gitignore glob semantics). Results are stat'd and
 * sorted by mtime ascending — recently modified files last, so the model reads
 * the freshest work first. Over-cap results spill to a temp file with a
 * locator line.
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { FsSearchSettings } from "../common/settings.ts";
import { runProcess } from "../common/subprocess.ts";
import { writeSpill } from "../common/tempfile.ts";

export interface GlobParams {
	pattern: string;
	path?: string;
}

export interface GlobResult {
	text: string;
	total: number;
	spillPath?: string;
}

export function displayPath(
	file: string,
	cwd: string,
	searchPath: string,
): string {
	const toCwd = relative(cwd, file);
	if (toCwd !== "" && !toCwd.startsWith(".."))
		return toCwd.split(/[\\/]/).join("/");
	const toSearch = relative(searchPath, file);
	if (toSearch !== "" && !toSearch.startsWith(".."))
		return toSearch.split(/[\\/]/).join("/");
	return file;
}

export async function runGlob(
	rgPath: string,
	params: GlobParams,
	settings: FsSearchSettings,
	cwd: string,
	signal?: AbortSignal,
): Promise<GlobResult> {
	if (!params.pattern || params.pattern.trim() === "") {
		throw new Error("SEARCH_INVALID_PATTERN: pattern must not be empty");
	}

	const rawPath = (params.path ?? ".").trim();
	const searchPath = resolve(
		cwd,
		rawPath.startsWith("@") ? rawPath.slice(1) : rawPath,
	);

	let st: Stats;
	try {
		st = await stat(searchPath);
	} catch {
		throw new Error(`SEARCH_FAILED: path not found: ${searchPath}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`SEARCH_FAILED: path is not a directory: ${searchPath}`);
	}

	const args = ["--files", "--no-config", "--hidden"];
	if (settings.noIgnore) args.push("--no-ignore");
	// Include first, exclusion LAST: rg globs use last-match-wins, so a broad
	// include after the exclusion would re-admit .git. Search root is "." with
	// cwd=searchPath so anchored patterns ("sub/*") match paths relative to it.
	args.push("-g", params.pattern, "-g", "!**/.git/**", ".");

	const res = await runProcess(rgPath, args, {
		cwd: searchPath,
		timeoutMs: settings.timeoutMs,
		graceMs: settings.graceMs,
		maxOutputBytes: settings.rawOutputMaxBytes,
		signal,
	});

	if (res.aborted) throw new Error("SEARCH_ABORTED: search aborted");
	if (res.timedOut) {
		throw new Error(
			`SEARCH_ABORTED: timed out after ${settings.timeoutMs}ms (pattern: ${params.pattern})`,
		);
	}
	if (res.stdoutTruncated) {
		throw new Error(
			`SEARCH_RAW_OUTPUT_OVERFLOW: raw output exceeded ${settings.rawOutputMaxBytes} bytes — narrow the pattern or search path`,
		);
	}
	if (res.code === 2) {
		throw new Error(
			`SEARCH_INVALID_PATTERN: ${res.stderr.toString("utf8").trim() || "invalid glob pattern"}`,
		);
	}
	if (res.code !== 0 && res.code !== 1) {
		throw new Error(
			`SEARCH_FAILED: rg exited with code ${res.code}: ${res.stderr.toString("utf8").trim()}`,
		);
	}

	const files = res.stdout
		.toString("utf8")
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => line !== "")
		.map((line) => resolve(searchPath, line.replace(/^\.\//, "")));

	const withMtime: { file: string; mtime: number }[] = [];
	for (const file of files) {
		try {
			const fst = await stat(file);
			withMtime.push({ file, mtime: fst.mtimeMs });
		} catch {
			// vanished between listing and stat — skip
		}
	}
	// mtime ascending, name as tiebreaker for determinism.
	withMtime.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));

	const total = withMtime.length;
	const display = withMtime.map((entry) =>
		displayPath(entry.file, cwd, searchPath),
	);

	if (total <= settings.globMaxResults) {
		return {
			text: total === 0 ? "No files found." : display.join("\n"),
			total,
		};
	}

	const capped = display.slice(0, settings.globMaxResults);
	let spillPath: string | undefined;
	let spillNote = "";
	try {
		spillPath = writeSpill("glob", display.join("\n"));
		spillNote = ` Full list: ${spillPath}`;
	} catch {
		spillNote = " (could not write spill file)";
	}
	const text =
		`${capped.join("\n")}\n\n` +
		`[Showing ${settings.globMaxResults} of ${total} files, sorted by mtime (oldest first).` +
		` Narrow the pattern or read the full list.]${spillNote}`;
	return { text, total, spillPath };
}
