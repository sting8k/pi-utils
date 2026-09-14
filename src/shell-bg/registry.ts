/**
 * The set of background jobs, in memory and mirrored to disk.
 *
 * The live Map is the source of truth while the session runs. Each job is also
 * written to a small JSON sidecar (atomically, temp + rename) so the status
 * tool still answers after a /reload re-instantiates the extension, and a job
 * that outran the session is reconciled: on load, a job still marked running
 * whose pid is no longer alive is settled rather than shown as forever-running.
 *
 * Scoped to one session via baseDir, so two pi sessions never reconcile each
 * other's jobs. Zero dependencies — node:fs/path.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord, type Job } from "./types.ts";

function isAlive(pid: number | null): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but we may not signal it — still alive.
		return (err as { code?: string }).code === "EPERM";
	}
}

function isJob(value: unknown): value is Job {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.command === "string" &&
		typeof value.logPath === "string" &&
		typeof value.status === "string"
	);
}

export class JobRegistry {
	private readonly jobs = new Map<string, Job>();
	private counter = 0;
	private readonly baseDir: string;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
		mkdirSync(join(baseDir, "logs"), { recursive: true });
	}

	logPathFor(id: string): string {
		return join(this.baseDir, "logs", `${id}.log`);
	}

	create(command: string, cwd: string): Job {
		const id = `bg-${++this.counter}`;
		const job: Job = {
			id,
			command,
			cwd,
			pid: null,
			status: "running",
			exitCode: null,
			signal: null,
			logPath: this.logPathFor(id),
			startedAt: Date.now(),
			endedAt: null,
			auto: false,
			delivered: false,
		};
		this.jobs.set(id, job);
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	all(): Job[] {
		return [...this.jobs.values()];
	}

	running(): Job[] {
		return this.all().filter((job) => job.status === "running");
	}

	persist(job: Job): void {
		try {
			const file = join(this.baseDir, `${job.id}.json`);
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(job));
			renameSync(tmp, file);
		} catch {
			// A registry we cannot persist still works for the live session.
		}
	}

	/** Load persisted jobs and settle any whose process has since died. */
	load(): Job[] {
		let files: string[];
		try {
			files = readdirSync(this.baseDir);
		} catch {
			return [];
		}
		const settled: Job[] = [];
		for (const name of files) {
			if (!name.endsWith(".json")) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(join(this.baseDir, name), "utf8"));
			} catch {
				continue;
			}
			if (!isJob(parsed)) continue;
			const job = parsed as Job;
			if (job.status === "running" && !isAlive(job.pid)) {
				job.status = "killed";
				job.endedAt = Date.now();
				settled.push(job);
				this.persist(job);
			}
			const numeric = Number.parseInt(job.id.replace(/^bg-/, ""), 10);
			if (Number.isFinite(numeric) && numeric > this.counter)
				this.counter = numeric;
			this.jobs.set(job.id, job);
		}
		return settled;
	}
}
