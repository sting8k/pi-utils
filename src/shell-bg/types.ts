/**
 * Shared shapes for the shell-bg extension.
 * No imports from pi packages: src/ typechecks and unit-tests standalone.
 *
 * Design credit: pifydev/shell-background (MIT) — self-implemented per
 * decision 0008 / D4.
 */

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface Job {
	/** Short session-monotonic id, e.g. "bg-1". */
	id: string;
	command: string;
	cwd: string;
	/** OS pid of the shell process; null before spawn or if spawn failed. */
	pid: number | null;
	status: JobStatus;
	/** Process exit code, once finished. */
	exitCode: number | null;
	/** Terminating signal name, if the process was signalled. */
	signal: string | null;
	/** Absolute path of the merged stdout+stderr log file. */
	logPath: string;
	startedAt: number;
	endedAt: number | null;
	/** True if it went to the background by outrunning the auto threshold. */
	auto: boolean;
	/** Whether the finished result has been delivered into the conversation. */
	delivered: boolean;
	/** Set when we killed it (timeout/abort/shell_kill), so exit reads as killed. */
	killedByUs?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finished job is anything past running. */
export function isFinished(job: Job): boolean {
	return job.status !== "running";
}
