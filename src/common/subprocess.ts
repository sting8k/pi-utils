/**
 * Argv-only subprocess runner: no shell, cooperative timeout + grace kill,
 * abort support, and a hard raw-output cap (exceeding it fails fast instead of
 * streaming a truncated result — dsh `rawOutputMaxBytes` semantics).
 *
 * Note: grep-core does NOT use this — it needs streaming JSON parsing with
 * early kill at the match limit (pi's built-in efficiency pattern). Only
 * glob-core and future small helpers run through here.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

export interface RunOptions {
	cwd?: string;
	/** Cooperative timeout: SIGTERM at timeoutMs, SIGKILL after graceMs. */
	timeoutMs?: number;
	graceMs?: number;
	/** Raw stdout cap in bytes. Exceeding marks stdoutTruncated and kills the child. */
	maxOutputBytes?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

export interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: Buffer;
	stderr: Buffer;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
	aborted: boolean;
}

export function runProcess(
	command: string,
	args: string[],
	options: RunOptions = {},
): Promise<RunResult> {
	const {
		cwd,
		timeoutMs,
		graceMs = 3_000,
		maxOutputBytes,
		signal,
		env,
	} = options;

	return new Promise<RunResult>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("SEARCH_ABORTED: aborted before start"));
			return;
		}

		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd,
				env: env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const killNow = () => {
			if (!child.killed) child.kill("SIGKILL");
		};
		const softKill = () => {
			if (!child.killed) child.kill("SIGTERM");
			const grace = setTimeout(killNow, graceMs);
			grace.unref?.();
		};

		const onAbort = () => {
			aborted = true;
			killNow();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let timeout: NodeJS.Timeout | undefined;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				softKill();
			}, timeoutMs);
			timeout.unref?.();
		}

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			if (timeout !== undefined) clearTimeout(timeout);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutTruncated) return;
			stdoutBytes += chunk.length;
			if (maxOutputBytes !== undefined && stdoutBytes > maxOutputBytes) {
				stdoutTruncated = true;
				killNow();
				return;
			}
			stdout.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			// stderr is diagnostics only: keep a bounded tail, never fail on volume.
			stderrBytes += chunk.length;
			stderr.push(chunk);
			if (stderrBytes > 64 * 1024) {
				stderr.shift();
				stderrTruncated = true;
			}
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err instanceof Error ? err : new Error(String(err)));
		});

		child.on("close", (code, closeSignal) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				code,
				signal: closeSignal,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				stdoutTruncated,
				stderrTruncated,
				timedOut,
				aborted,
			});
		});
	});
}
