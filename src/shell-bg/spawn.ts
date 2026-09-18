/**
 * Spawn a shell command whose output streams to a log file, cross-platform.
 *
 * The obvious trick — hand the child the file's own descriptor as stdio so the
 * kernel writes it with zero JS in the path — is POSIX-only; on Windows a
 * numeric fd in `stdio` does not inherit the way it does on Unix, so the
 * portable path is to pipe stdout/stderr and write them into one log file
 * ourselves. Losslessness depends on draining the pipes on every chunk and on
 * not finalizing before the tail arrives: after the process exits we wait for
 * both pipes to end, with a short grace timer so a quiet inherited handle
 * still releases.
 *
 * `detached` (POSIX) makes the child a process-group leader so its whole tree
 * can be signalled (see kill.ts); `unref` keeps a running job from holding the
 * host's event loop open. Jobs die with the session (killed on shutdown), so
 * pipes owned by the parent are the right model.
 *
 * Design credit: pifydev/shell-background (MIT).
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface Spawned {
	pid: number | null;
	/** Resolves once, when the process exits (after output drained) or fails to start. */
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const DRAIN_GRACE_MS = 150;

export function spawnToFile(
	shell: string,
	shellArgs: readonly string[],
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	logPath: string,
): Spawned {
	// Append so a re-attach or racing read never clips output already written.
	const out = createWriteStream(logPath, { flags: "a" });
	// A write stream reports an unopenable path by EMITTING "error", not by
	// throwing — with no listener that is an unhandled 'error' event, which
	// takes the whole pi host down. Reachable whenever the log path stops
	// being writable: the session dir swept from under us, a full disk, lost
	// permissions. The job still settles on process exit; the missing output
	// is reported honestly by readTail (see tail.ts).
	out.on("error", () => {});

	let child: ChildProcess;
	try {
		child = spawn(shell, [...shellArgs, command], {
			cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch {
		out.end();
		return { pid: null, exit: Promise.resolve({ code: null, signal: null }) };
	}

	const pump = (stream: NodeJS.ReadableStream | null) => {
		stream?.on("data", (chunk) => {
			try {
				out.write(chunk);
			} catch {
				// A closed sink must not crash the reader.
			}
		});
	};
	pump(child.stdout);
	pump(child.stderr);

	const exit = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		let settled = false;
		let info: { code: number | null; signal: NodeJS.Signals | null } | null =
			null;
		const stdoutEnded = child.stdout === null;
		const stderrEnded = child.stderr === null;

		const finish = () => {
			if (settled || !info) return;
			settled = true;
			try {
				out.end();
			} catch {
				// already closed
			}
			resolve(info);
		};
		const maybeFinish = () => {
			if (info && stdoutEnded && stderrEnded) finish();
			else if (info && !settled) {
				const grace = setTimeout(finish, DRAIN_GRACE_MS);
				grace.unref?.();
			}
		};

		child.stdout?.on("end", maybeFinish);
		child.stderr?.on("end", maybeFinish);
		child.on("exit", (code, signal) => {
			info = { code, signal };
			maybeFinish();
		});
		child.on("error", () => {
			info = info ?? { code: null, signal: null };
			maybeFinish();
		});
	});

	child.unref?.();
	return { pid: child.pid ?? null, exit };
}
