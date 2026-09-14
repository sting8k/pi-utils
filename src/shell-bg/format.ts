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

/** Running jobs capped for the widget; extras collapse into a "⋯ and N more" row. */
export const MAX_WIDGET_ROWS = 5;

export interface WidgetRow {
	id: string;
	/** Raw command; the painter normalizes whitespace and clips to width. */
	command: string;
	elapsedText: string;
	auto: boolean;
}

/** Pure data for the above-editor widget; painting (theme/width) is the caller's. */
export interface WidgetModel {
	running: number;
	rows: WidgetRow[];
	/** Running jobs hidden by MAX_WIDGET_ROWS. */
	hidden: number;
}

/** Model of running jobs only; an empty model clears the widget. Sync: one
 * line per job keeps the widget stateless to refresh each tick. */
export function widgetModel(jobs: Job[], now = Date.now()): WidgetModel {
	const running = jobs.filter((job) => job.status === "running");
	const visible = running.slice(0, MAX_WIDGET_ROWS);
	return {
		running: running.length,
		rows: visible.map((job) => ({
			id: job.id,
			command: job.command,
			elapsedText: elapsed(now - job.startedAt),
			auto: job.auto,
		})),
		hidden: running.length - visible.length,
	};
}
