/**
 * Rendering helpers for shell-bg: job headers, finished results, status lists,
 * and the widget lines shown above the editor while jobs run.
 */

import { readTail } from "./tail.ts";
import type { Job } from "./types.ts";

function elapsed(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

function clip(command: string, max = 60): string {
	const one = command.replace(/\s+/g, " ").trim();
	return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function header(job: Job): string {
	const bits = [job.id, clip(job.command)];
	if (job.status === "running") {
		bits.push(`running ${elapsed(Date.now() - job.startedAt)}`);
		if (job.auto) bits.push("(auto)");
	} else {
		bits.push(job.status);
		if (job.exitCode !== null && job.exitCode !== 0)
			bits.push(`exit ${job.exitCode}`);
		if (job.signal) bits.push(`signal ${job.signal}`);
	}
	return bits.join(" · ");
}

/** The full text for a FINISHED job (status line + output tail). */
export async function formatResult(
	job: Job,
	tailBytes: number,
): Promise<string> {
	const tail = await readTail(job.logPath, tailBytes);
	const output = tail.text.replace(/\n+$/, "");
	const head = header(job);
	if (output === "") return `${head}\n(no output)`;
	return `${head}\n${output}`;
}

/** Snapshot of a RUNNING job: header + output so far. */
export async function formatSnapshot(
	job: Job,
	tailBytes: number,
): Promise<string> {
	const tail = await readTail(job.logPath, tailBytes);
	const output = tail.text.replace(/\n+$/, "");
	if (output === "") return `${header(job)}\n(no output yet)`;
	return `${header(job)}\n${output}`;
}

/** One line per job for lists (shell_status with no id, /shell-bg, widget). */
export function formatList(jobs: Job[], now = Date.now()): string {
	if (jobs.length === 0) return "No background jobs this session.";
	return jobs
		.map((job) => {
			if (job.status === "running") {
				return `${job.id} · running ${elapsed(now - job.startedAt)}${job.auto ? " (auto)" : ""} · ${clip(job.command, 48)}`;
			}
			const code = job.exitCode === null ? "" : ` · exit ${job.exitCode}`;
			const delivered = job.delivered ? " · delivered" : "";
			return `${job.id} · ${job.status}${code}${delivered} · ${clip(job.command, 48)}`;
		})
		.join("\n");
}

/** Widget lines: only running jobs; cleared when the last one settles. */
export async function widgetLines(
	jobs: Job[],
	tailBytes: number,
): Promise<string[]> {
	const running = jobs.filter((job) => job.status === "running");
	const lines: string[] = [];
	for (const job of running) {
		const tail = await readTail(job.logPath, tailBytes);
		const lastLine =
			tail.text.replace(/\n+$/, "").split("\n").filter(Boolean).pop() ??
			"(no output yet)";
		lines.push(`${header(job)}`);
		lines.push(`  ${lastLine.slice(0, 120)}`);
	}
	return lines;
}
