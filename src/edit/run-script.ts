/**
 * Script-mode core for the edit override (US-003): snapshot the declared
 * paths, spawn the interpreter with the code on stdin, capture capped
 * stdout/stderr (overflow spills to a temp file), kill the whole process
 * tree on timeout/abort, and roll every declared path back from the
 * snapshot on failure.
 *
 * Own spawn instead of src/common/subprocess.ts: that runner ignores stdin,
 * and here the code IS the stdin payload (stdout/stderr capping semantics
 * follow the same conventions though).
 *
 * Not a security boundary: the script runs with full user privileges and
 * undeclared writes are invisible by contract (no git, owner decision).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeSpill } from "../common/tempfile.ts";
import { killTree } from "../shell-bg/kill.ts";
import { type PathSnapshot, snapshotPaths } from "./snapshot.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SPILL_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;

export interface RunEditScriptOptions {
	code: string;
	/** Declared paths (the whole contract boundary). */
	paths: string[];
	lang: "python" | "node";
	/** Whole process tree is killed past it. */
	timeoutSec: number;
	cwd: string;
	signal?: AbortSignal;
	/** Per-stream stdout/stderr memory cap; overflow spills to a temp file. */
	maxOutputBytes?: number;
	/** Extra child env, merged over process.env (tests: interpreter-path control). */
	env?: NodeJS.ProcessEnv;
	/** Override the interpreter candidate chain (platform/tests: absent runtimes). */
	interpreterCandidates?: string[][];
}

export type FileChange = {
	path: string;
	kind: "created" | "modified" | "deleted";
	/** Byte content before/after, null = absent. Diffing happens at the caller. */
	oldContent: string | null;
	newContent: string | null;
};

export type ScriptOutcome =
	| {
			ok: true;
			changes: FileChange[];
			exitCode: 0;
			stdout: string;
			stderr: string;
			stdoutTruncated: boolean;
			stderrTruncated: boolean;
			spillPath?: string;
			elapsedMs: number;
			warnings: string[];
	  }
	| {
			ok: false;
			rolledBack: true;
			exitCode: number | null;
			timedOut: boolean;
			aborted: boolean;
			stdout: string;
			stderr: string;
			spillPath?: string;
			elapsedMs: number;
			warnings: string[];
			/** Declared paths the script had touched before the restore ran. */
			dirtyBeforeRestore: string[];
			/** Paths that could not be restored — surfaced loudly by the caller. */
			restoreFailures: string[];
			spawnError?: string;
	  };

function interpreterCommands(lang: "python" | "node"): string[][] {
	return lang === "node"
		? [["node", "-"]]
		: [
				["python3", "-"],
				["python", "-"],
			];
}

export function runEditScript(
	options: RunEditScriptOptions,
): Promise<ScriptOutcome> {
	const {
		code,
		paths,
		lang,
		timeoutSec,
		cwd,
		signal,
		maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
		env: extraEnv,
	} = options;
	const snapshot = snapshotPaths(paths);
	const started = Date.now();

	return spawnInterpreter(lang, options.interpreterCandidates).then(
		(outcome) => {
			const elapsedMs = Date.now() - started;
			if (!outcome.ok) {
				const restoreFailures = snapshot.restore();
				return {
					ok: false,
					rolledBack: true,
					exitCode: null,
					timedOut: false,
					aborted: false,
					stdout: "",
					stderr: "",
					elapsedMs,
					warnings: snapshot.warnings,
					dirtyBeforeRestore: [],
					restoreFailures,
					spawnError: outcome.message,
				} satisfies ScriptOutcome;
			}

			const run = outcome;
			if (run.code === 0 && !run.timedOut && !run.aborted) {
				const changes = classifyChanges(snapshot);
				return {
					ok: true,
					changes,
					exitCode: 0 as const,
					stdout: run.stdout,
					stderr: run.stderr,
					stdoutTruncated: run.stdoutTruncated,
					stderrTruncated: run.stderrTruncated,
					spillPath: run.spillPath,
					elapsedMs,
					warnings: snapshot.warnings,
				} satisfies ScriptOutcome;
			}

			const dirtyBeforeRestore = dirtyPaths(snapshot);
			const restoreFailures = snapshot.restore();
			return {
				ok: false,
				rolledBack: true,
				exitCode: run.code,
				timedOut: run.timedOut,
				aborted: run.aborted,
				stdout: run.stdout,
				stderr: run.stderr,
				spillPath: run.spillPath,
				elapsedMs,
				warnings: snapshot.warnings,
				dirtyBeforeRestore,
				restoreFailures,
			} satisfies ScriptOutcome;
		},
	);

	type InterpreterRun = {
		ok: true;
		code: number | null;
		timedOut: boolean;
		aborted: boolean;
		stdout: string;
		stderr: string;
		stdoutTruncated: boolean;
		stderrTruncated: boolean;
		spillPath?: string;
	};

	function spawnInterpreter(
		lang: "python" | "node",
		interpreterCandidates?: string[][],
	): Promise<InterpreterRun | { ok: false; message: string }> {
		const commands = interpreterCandidates ?? interpreterCommands(lang);

		const tryNext = (
			index: number,
		): Promise<InterpreterRun | { ok: false; message: string }> => {
			const command = commands[index];
			if (command === undefined) {
				return Promise.resolve({
					ok: false,
					message: `no ${lang} interpreter found — pass lang:"node" (node runs Pi itself, always available)`,
				});
			}
			return spawnOne(command).then((result) =>
				result === null ? tryNext(index + 1) : result,
			);
		};
		return tryNext(0);
	}

	function spawnOne(
		command: string[],
	): Promise<InterpreterRun | { ok: false; message: string } | null> {
		const [cmd, ...args] = command;
		return new Promise((resolve) => {
			let child: ReturnType<typeof spawn>;
			try {
				if (cmd === undefined) throw new Error("empty interpreter command");
				child = spawn(cmd, args, {
					cwd,
					env: { ...process.env, ...extraEnv, PYTHONIOENCODING: "utf-8" },
					// Detached → process-group leader, so killTree reaches the
					// whole tree (same semantics as shell-bg). Not unref'd.
					detached: true,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				resolve({
					ok: false,
					message: err instanceof Error ? err.message : String(err),
				});
				return;
			}

			let settled = false;
			let timedOut = false;
			let aborted = false;
			let spillPath: string | undefined;

			const streams = {
				stdout: {
					chunks: [] as Buffer[],
					bytes: 0,
					truncated: false,
					overflow: [] as Buffer[],
					overflowBytes: 0,
				},
				stderr: {
					chunks: [] as Buffer[],
					bytes: 0,
					truncated: false,
					overflow: [] as Buffer[],
					overflowBytes: 0,
				},
			};
			const collect = (
				stream: (typeof streams)["stdout"],
				chunk: Buffer,
			): void => {
				if (!stream.truncated) {
					stream.bytes += chunk.length;
					if (stream.bytes <= maxOutputBytes) {
						stream.chunks.push(chunk);
						return;
					}
					stream.truncated = true;
				}
				if (stream.overflowBytes < MAX_SPILL_BYTES) {
					const room = MAX_SPILL_BYTES - stream.overflowBytes;
					stream.overflowBytes += chunk.length;
					stream.overflow.push(
						room < chunk.length ? chunk.subarray(0, room) : chunk,
					);
				}
			};
			child.stdout?.on("data", (chunk: Buffer) =>
				collect(streams.stdout, chunk),
			);
			child.stderr?.on("data", (chunk: Buffer) =>
				collect(streams.stderr, chunk),
			);

			const finish = (code: number | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				child.stdin?.destroy();
				for (const [name, stream] of Object.entries(streams)) {
					if (stream.overflow.length > 0 && spillPath === undefined) {
						spillPath = writeSpill(
							`edit-${name}`,
							Buffer.concat(stream.overflow).toString("utf8"),
						);
					}
				}
				resolve({
					ok: true,
					code,
					timedOut,
					aborted,
					stdout: Buffer.concat(streams.stdout.chunks).toString("utf8"),
					stderr: Buffer.concat(streams.stderr.chunks).toString("utf8"),
					stdoutTruncated: streams.stdout.truncated,
					stderrTruncated: streams.stderr.truncated,
					spillPath,
				});
			};

			const kill = (): void => {
				if (child.pid !== undefined) killTree(child.pid, KILL_GRACE_MS);
			};
			const onAbort = (): void => {
				aborted = true;
				kill();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const timeout = setTimeout(() => {
				timedOut = true;
				kill();
			}, timeoutSec * 1000);
			timeout.unref?.();

			child.on("error", (err) => {
				if (settled) return;
				// ENOENT → try the next interpreter candidate; anything else is real.
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					settled = true;
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
					resolve(null);
					return;
				}
				settled = true;
				clearTimeout(timeout);
				resolve({ ok: false, message: err.message });
			});
			child.on("close", (code) => finish(code));

			// The code is the stdin payload; an early-exited child makes the
			// write fail with EPIPE — the exit code settles the outcome.
			const stdin = child.stdin;
			if (stdin) {
				stdin.on("error", () => {});
				stdin.write(code);
				stdin.end();
			}
		});
	}
}

/** Compare the live state of declared paths against the snapshot. */
function classifyChanges(snapshot: PathSnapshot): FileChange[] {
	const changes: FileChange[] = [];
	for (const entry of snapshot.entries) {
		let current: Buffer | null = null;
		try {
			current = readFileSync(entry.path);
		} catch {
			current = null; // absent now
		}
		const before =
			entry.present && entry.content !== null ? entry.content : null;
		if (sameBytes(before, current)) continue;
		const kind =
			before === null && current !== null
				? "created"
				: before !== null && current === null
					? "deleted"
					: "modified";
		changes.push({
			path: entry.path,
			kind,
			oldContent: before?.toString("utf8") ?? null,
			newContent: current?.toString("utf8") ?? null,
		});
	}
	return changes;
}

function dirtyPaths(snapshot: PathSnapshot): string[] {
	const dirty: string[] = [];
	for (const entry of snapshot.entries) {
		let current: Buffer | null = null;
		try {
			current = readFileSync(entry.path);
		} catch {
			current = null;
		}
		if (!sameBytes(entry.present ? entry.content : null, current)) {
			dirty.push(entry.path);
		}
	}
	return dirty;
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	return a.equals(b);
}
