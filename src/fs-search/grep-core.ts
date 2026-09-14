/**
 * grep tool core — fork of pi's built-in streaming grep (MIT,
 * @earendil-works/pi-coding-agent) merged with dsh semantics:
 *
 * - streaming JSON parse with early kill once the match limit is reached
 *   (pi's efficiency pattern — do not buffer what will be discarded);
 * - `--no-config` always (blocks RIPGREP_CONFIG_PATH injection);
 * - `--no-ignore` by default + `!.git` exclusion: gitignored files are
 *   searched — that is the discovery point (dsh), overridable per call;
 * - cooperative timeout + grace kill, raw-output overflow guard, stderr tail;
 * - rg exit 1 (no matches) is SUCCESS; exit 2 is SEARCH_INVALID_PATTERN;
 * - byte-bounded line previews that never split a UTF-8 sequence;
 * - byte-capped inline output with spill-to-tempfile locator (D5).
 *
 * No imports from pi packages: rgPath/cwd are injected.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FsSearchSettings } from "../common/settings.ts";
import { writeSpill } from "../common/tempfile.ts";
import { displayPath } from "./glob-core.ts";

export interface GrepParams {
	pattern: string;
	path?: string;
	include?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
	/** Overrides settings.noIgnore for this call. */
	noIgnore?: boolean;
}

export interface GrepResult {
	text: string;
	matchCount: number;
	fileCount: number;
	matchLimitReached: boolean;
	spillPath?: string;
}

interface Match {
	file: string;
	line: number;
	text: string;
}

const INLINE_MAX_BYTES = 50_000; // pi's DEFAULT_MAX_BYTES

export function truncateLineBytes(
	line: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const cleaned = line.replace(/\r/g, "").replace(/\n+$/, "");
	const buf = Buffer.from(cleaned, "utf8");
	if (buf.length <= maxBytes) return { text: cleaned, truncated: false };
	let end = maxBytes;
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1; // back up over UTF-8 continuation bytes
	return {
		text: `${buf.subarray(0, end).toString("utf8")}… [line truncated]`,
		truncated: true,
	};
}

/** Keep head lines while total bytes stay under maxBytes; never splits a line. */
function capLines(
	lines: string[],
	maxBytes: number,
): { lines: string[]; bytes: number } {
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + lineBytes > maxBytes) break;
		kept.push(line);
		bytes += lineBytes;
	}
	return { lines: kept, bytes };
}

function stderrTail(stderr: string): string {
	return stderr.length > 2_000 ? `…${stderr.slice(-2_000)}` : stderr;
}

export async function runGrep(
	rgPath: string,
	params: GrepParams,
	settings: FsSearchSettings,
	cwd: string,
	signal?: AbortSignal,
): Promise<GrepResult> {
	if (!params.pattern || params.pattern === "") {
		throw new Error("SEARCH_INVALID_PATTERN: pattern must not be empty");
	}
	if (params.include !== undefined) {
		if (params.include.includes(",")) {
			throw new Error(
				`SEARCH_INVALID_PATTERN: include accepts a single positive glob, got comma list "${params.include}" — run separate greps per glob instead`,
			);
		}
		if (params.include.startsWith("!")) {
			throw new Error(
				`SEARCH_INVALID_PATTERN: include accepts a single positive glob, got negation "${params.include}" — filter results yourself instead`,
			);
		}
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

	const noIgnore = params.noIgnore ?? settings.noIgnore;
	const limit = Math.max(1, params.limit ?? settings.grepMaxMatches);
	const contextValue =
		params.context && params.context > 0 ? params.context : 0;

	const args = [
		"--json",
		"--line-number",
		"--color=never",
		"--no-config",
		"--hidden",
	];
	if (noIgnore) args.push("--no-ignore");
	// Include before the exclusion (rg globs are last-match-wins). Search root
	// is "." with cwd=searchPath so anchored includes ("src/*.ts") match paths
	// relative to it; when the target is a single file, pass it absolutely.
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.include !== undefined) args.push("--glob", params.include);
	args.push("-g", "!**/.git/**");
	const searchArg = st.isDirectory() ? "." : searchPath;
	const spawnCwd = st.isDirectory() ? searchPath : cwd;
	args.push("--", params.pattern, searchArg);

	return await new Promise<GrepResult>((resolvePromise, rejectPromise) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		let child: ChildProcess;
		try {
			child = spawn(rgPath, args, {
				cwd: spawnCwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			rejectPromise(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		if (signal?.aborted) {
			child.kill("SIGKILL");
			rejectPromise(new Error("SEARCH_ABORTED: search aborted"));
			return;
		}

		const matches: Match[] = [];
		let stderr = "";
		let stdoutBytes = 0;
		let overflowed = false;
		let timedOut = false;
		let aborted = false;
		let matchLimitReached = false;
		let killedForLimit = false;

		const hardKill = () => {
			if (!child.killed) child.kill("SIGKILL");
		};
		const onAbort = () => {
			aborted = true;
			hardKill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let timeout: NodeJS.Timeout | undefined;
		let grace: NodeJS.Timeout | undefined;
		if (settings.timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				if (!child.killed) child.kill("SIGTERM");
				grace = setTimeout(hardKill, settings.graceMs);
				grace.unref?.();
			}, settings.timeoutMs);
			timeout.unref?.();
		}

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			if (timeout !== undefined) clearTimeout(timeout);
			if (grace !== undefined) clearTimeout(grace);
		};

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
		});

		const stdout = child.stdout;
		if (stdout === null) {
			cleanup();
			settle(() => rejectPromise(new Error("SEARCH_FAILED: no stdout stream")));
			return;
		}
		const rl = createInterface({ input: stdout });
		rl.on("line", (line: string) => {
			if (overflowed) return;
			stdoutBytes += Buffer.byteLength(line, "utf8") + 1;
			if (stdoutBytes > settings.rawOutputMaxBytes) {
				overflowed = true;
				hardKill();
				return;
			}
			if (matchLimitReached) return;
			let event: {
				type?: string;
				data?: {
					path?: { text?: string };
					line_number?: number;
					lines?: { text?: string };
				};
			};
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "match") return;
			const rawFile = event.data?.path?.text;
			const lineNo = event.data?.line_number;
			if (typeof rawFile !== "string" || typeof lineNo !== "number") return;
			// Paths arrive relative to the search root ("./src/a.ts") or absolute.
			const file = isAbsolute(rawFile)
				? rawFile
				: resolve(searchPath, rawFile.replace(/^\.\//, ""));
			matches.push({ file, line: lineNo, text: event.data?.lines?.text ?? "" });
			if (matches.length >= limit) {
				matchLimitReached = true;
				killedForLimit = true;
				if (!child.killed) child.kill("SIGTERM");
			}
		});

		child.on("error", (err) => {
			cleanup();
			settle(() => rejectPromise(new Error(`SEARCH_FAILED: ${err.message}`)));
		});

		child.on("close", async (code, closeSignal) => {
			cleanup();
			rl.close();

			if (aborted) {
				settle(() =>
					rejectPromise(new Error("SEARCH_ABORTED: search aborted")),
				);
				return;
			}
			if (timedOut) {
				settle(() =>
					rejectPromise(
						new Error(
							`SEARCH_ABORTED: timed out after ${settings.timeoutMs}ms — narrow the search`,
						),
					),
				);
				return;
			}
			if (overflowed) {
				settle(() =>
					rejectPromise(
						new Error(
							`SEARCH_RAW_OUTPUT_OVERFLOW: raw output exceeded ${settings.rawOutputMaxBytes} bytes — narrow the pattern, add include, or raise limit`,
						),
					),
				);
				return;
			}
			// killedForLimit: expected — code may be null/1 with a signal.
			if (!killedForLimit && code !== 0 && code !== 1) {
				const detail = stderrTail(stderr.trim());
				if (code === 2) {
					settle(() =>
						rejectPromise(
							new Error(
								`SEARCH_INVALID_PATTERN: ${detail || "invalid pattern"}`,
							),
						),
					);
				} else {
					settle(() =>
						rejectPromise(
							new Error(
								`SEARCH_FAILED: rg exited ${code}${closeSignal ? ` (${closeSignal})` : ""}: ${detail}`,
							),
						),
					);
				}
				return;
			}

			try {
				const formatted = await formatMatches(matches, {
					cwd,
					searchPath,
					context: contextValue,
					maxLineBytes: settings.grepMaxLineBytes,
					limit,
					matchLimitReached,
				});
				settle(() => resolvePromise(formatted));
			} catch (err) {
				settle(() =>
					rejectPromise(err instanceof Error ? err : new Error(String(err))),
				);
			}
		});
	});
}

async function formatMatches(
	matches: Match[],
	opts: {
		cwd: string;
		searchPath: string;
		context: number;
		maxLineBytes: number;
		limit: number;
		matchLimitReached: boolean;
	},
): Promise<GrepResult> {
	if (matches.length === 0) {
		return {
			text: "No matches found.",
			matchCount: 0,
			fileCount: 0,
			matchLimitReached: false,
		};
	}

	const lineCache = new Map<string, string[]>();
	const getLines = async (file: string): Promise<string[]> => {
		let lines = lineCache.get(file);
		if (!lines) {
			try {
				const content = await readFile(file, "utf8");
				lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			lineCache.set(file, lines);
		}
		return lines;
	};

	const outLines: string[] = [];
	let lineTruncated = false;
	const fmt = (
		file: string,
		line: number,
		text: string,
		isMatch: boolean,
	): void => {
		const { text: preview, truncated } = truncateLineBytes(
			text,
			opts.maxLineBytes,
		);
		if (truncated) lineTruncated = true;
		const shown = opts.context > 0 || isMatch ? preview : "";
		if (shown === "") return;
		const path = displayPath(file, opts.cwd, opts.searchPath);
		outLines.push(
			isMatch ? `${path}:${line}: ${preview}` : `${path}-${line}- ${preview}`,
		);
	};

	const files = new Set<string>();
	for (const match of matches) {
		files.add(match.file);
		if (opts.context === 0) {
			fmt(match.file, match.line, match.text, true);
			continue;
		}
		const lines = await getLines(match.file);
		if (lines.length === 0) {
			const path = basename(match.file);
			outLines.push(`${path}:${match.line}: (unable to read file)`);
			continue;
		}
		const start = Math.max(1, match.line - opts.context);
		const end = Math.min(lines.length, match.line + opts.context);
		for (let current = start; current <= end; current++) {
			const text = (lines[current - 1] ?? "").replace(/\r/g, "");
			fmt(match.file, current, text, current === match.line);
		}
	}

	const notices: string[] = [];
	if (opts.matchLimitReached) {
		notices.push(
			`${opts.limit} matches limit reached — use limit=${opts.limit * 2} for more, or refine the pattern`,
		);
	}
	if (lineTruncated) {
		notices.push(
			`some lines truncated to ${opts.maxLineBytes} bytes — use read to see full lines`,
		);
	}

	let spillPath: string | undefined;
	const header = `${matches.length} matches in ${files.size} files`;
	let body = outLines;

	const totalBytes = Buffer.byteLength(outLines.join("\n"), "utf8");
	if (totalBytes > INLINE_MAX_BYTES) {
		const capped = capLines(outLines, INLINE_MAX_BYTES);
		let spillNote = "";
		try {
			spillPath = writeSpill("grep", `${header}\n${outLines.join("\n")}`);
			spillNote = ` Full output: ${spillPath}`;
		} catch {
			spillNote = " (could not write spill file)";
		}
		notices.push(
			`output truncated to ${capped.lines.length} of ${outLines.length} lines (${capped.bytes} bytes)${spillNote}`,
		);
		body = capped.lines;
	}

	const text = [
		header,
		...body,
		notices.length > 0 ? `\n[${notices.join(". ")}]` : "",
	]
		.filter((part) => part !== "")
		.join("\n");

	return {
		text,
		matchCount: matches.length,
		fileCount: files.size,
		matchLimitReached: opts.matchLimitReached,
		spillPath,
	};
}

/** Exported for tests. */
export function relativeDisplay(
	file: string,
	cwd: string,
	searchPath: string,
): string {
	return displayPath(file, cwd, searchPath) || basename(file);
}
