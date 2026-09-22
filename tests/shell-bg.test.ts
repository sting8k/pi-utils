import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatList,
	formatResult,
	header,
	MAX_WIDGET_ROWS,
	widgetModel,
} from "../src/shell-bg/format.ts";
import {
	backgroundedResult,
	DELIVERY_TYPE,
	deliveryMessage,
} from "../src/shell-bg/pending.ts";
import {
	gcSessionDirs,
	JobRegistry,
	sessionKeyFor,
} from "../src/shell-bg/registry.ts";
import { spawnToFile } from "../src/shell-bg/spawn.ts";
import { readTail } from "../src/shell-bg/tail.ts";
import type { Job } from "../src/shell-bg/types.ts";

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-utils-shellbg-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("JobRegistry", () => {
	test("create/persist/load round-trips a job", () => {
		const registry = new JobRegistry(join(dir, "r1"));
		const job = registry.create("echo hi", "/tmp");
		job.pid = 424242; // dead pid — nobody owns this
		job.status = "done";
		job.exitCode = 0;
		job.endedAt = Date.now();
		registry.persist(job);

		const reloaded = new JobRegistry(join(dir, "r1"));
		const settled = reloaded.load();
		expect(settled).toEqual([]);
		const loaded = reloaded.get("bg-1");
		expect(loaded?.command).toBe("echo hi");
		expect(loaded?.status).toBe("done");
		expect(loaded?.pid).toBe(424242);

		// Counter continues after reload.
		expect(reloaded.create("next", "/tmp").id).toBe("bg-2");
	});

	test("load settles a running job whose pid is dead", () => {
		const registry = new JobRegistry(join(dir, "r2"));
		const job = registry.create("sleep 100", "/tmp");
		job.pid = 999_999; // no such process
		registry.persist(job);

		const reloaded = new JobRegistry(join(dir, "r2"));
		const settled = reloaded.load();
		expect(settled.length).toBe(1);
		expect(settled[0]?.status).toBe("killed");
		expect(reloaded.get("bg-1")?.status).toBe("killed");
	});

	test("load keeps a running job whose pid is alive", () => {
		const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		const registry = new JobRegistry(join(dir, "r3"));
		try {
			const job = registry.create("sleep 30", "/tmp");
			job.pid = child.pid ?? null;
			registry.persist(job);

			const reloaded = new JobRegistry(join(dir, "r3"));
			const settled = reloaded.load();
			expect(settled).toEqual([]);
			expect(reloaded.get("bg-1")?.status).toBe("running");
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("log paths live under the registry base dir", () => {
		const registry = new JobRegistry(join(dir, "r4"));
		const job = registry.create("x", "/tmp");
		expect(job.logPath.startsWith(join(dir, "r4", "logs"))).toBe(true);
	});
});

describe("readTail", () => {
	test("returns the last N bytes without splitting a character", async () => {
		const file = join(dir, "tail.log");
		const body = `${"x".repeat(3000)}m\u00fcnchen`; // 'ü' is 2 bytes
		writeFileSync(file, body);
		const exact = await readTail(file, 8);
		expect(exact.text).toBe("m\u00fcnchen");
		// Cutting inside 'ü' must drop the partial character, not garble it.
		const split = await readTail(file, 6);
		expect(split.text).toBe("nchen");
	});

	test("missing file yields empty and is flagged unavailable", async () => {
		const tail = await readTail(join(dir, "missing.log"), 100);
		expect(tail.text).toBe("");
		// Told apart from a command that simply printed nothing.
		expect(tail.available).toBe(false);
		const present = join(dir, "empty.log");
		writeFileSync(present, "");
		expect((await readTail(present, 100)).available).toBe(true);
	});

	test("an unreadable log reads as unavailable, not as no output", async () => {
		const job: Job = {
			id: "bg-9",
			command: "echo hi",
			cwd: dir,
			pid: 1,
			status: "done",
			exitCode: 0,
			signal: null,
			logPath: join(dir, "gone.log"),
			startedAt: Date.now(),
			endedAt: Date.now(),
			auto: false,
			delivered: false,
		};
		expect(await formatResult(job, 100)).toContain("output unavailable");
		writeFileSync(job.logPath, "");
		expect(await formatResult(job, 100)).toContain("(no output)");
	});
});

describe("pending messages", () => {
	const base: Job = {
		id: "bg-1",
		command: "npm run build",
		cwd: "/repo",
		pid: null,
		status: "running",
		exitCode: null,
		signal: null,
		logPath: "/tmp/x.log",
		startedAt: Date.now() - 45_000,
		endedAt: null,
		auto: true,
		delivered: false,
	};

	test("auto-background message states the elapsed time and collect tool", () => {
		const r = backgroundedResult({
			id: "bg-1",
			command: "npm run build",
			elapsedMs: 45_000,
			auto: true,
			interactive: true,
			collectWith: "shell_status",
		});
		expect(r.text).toContain("still running after 45s");
		expect(r.text).toContain("no need to poll");
		expect(r.text).toContain("(shell_status)");
		expect(r.details.pollRequired).toBe(false);
	});

	test("headless message demands polling within the turn", () => {
		const r = backgroundedResult({
			id: "bg-2",
			command: "cargo test",
			elapsedMs: 0,
			auto: false,
			interactive: false,
			collectWith: "shell_status",
		});
		expect(r.text).toContain("Headless run");
		expect(r.details.pollRequired).toBe(true);
	});

	test("delivery message wraps the body with the id", () => {
		const m = deliveryMessage([{ id: "bg-1", body: "exit 0\nok" }]);
		expect(m).toContain('<shell_bg_result id="bg-1">');
		expect(m).toContain("bg-1 — background job finished, result above.");
		expect(m).toContain("no need to poll (shell_status)");
		expect(DELIVERY_TYPE).toBe("pi-utils-shell-bg-result");
	});

	test("delivery message batches several finished jobs into one block set", () => {
		const m = deliveryMessage([
			{ id: "bg-1", body: "exit 0\nok" },
			{ id: "bg-2", body: "exit 1\nboom" },
		]);
		expect(m).toContain('<shell_bg_result id="bg-1">');
		expect(m).toContain('<shell_bg_result id="bg-2">');
		expect(m.indexOf("bg-1")).toBeLessThan(m.indexOf("bg-2"));
		expect(m).toContain(
			"bg-1, bg-2 — background jobs finished, results above.",
		);
	});

	test("formatList and header render jobs", () => {
		expect(formatList([])).toContain("No background jobs");
		expect(
			header({ ...base, status: "done", exitCode: 0, endedAt: Date.now() }),
		).toContain("done");
		const list = formatList([
			base,
			{ ...base, id: "bg-2", status: "failed", exitCode: 1, delivered: true },
		]);
		expect(list).toContain("bg-1 · running");
		expect(list).toContain("bg-2 · failed · exit 1 · delivered");
		expect(list).toContain("2 jobs this session · 1 running");
	});

	test("formatList caps rows, keeps totals true, and points at the rest", () => {
		const jobs: Job[] = Array.from({ length: 25 }, (_, i) => ({
			...base,
			id: `bg-${i + 1}`,
			status: "done",
			exitCode: 0,
			startedAt: 1_000 + i,
			endedAt: 2_000 + i,
		}));
		const list = formatList(jobs, 5_000);
		const rows = list.split("\n");
		expect(rows[0]).toBe("25 jobs this session · 0 running · 10 shown");
		// Header + 10 rows + the "and N more" line.
		expect(rows).toHaveLength(12);
		expect(rows[1]).toContain("bg-25");
		expect(rows[10]).toContain("bg-16");
		expect(rows[11]).toContain("… and 15 more");
	});

	test("formatList never lets finished jobs push out a running one", () => {
		// The running job started first, so pure recency ordering would cut it.
		const jobs: Job[] = [
			{ ...base, id: "bg-1", status: "running", startedAt: 1_000 },
			...Array.from({ length: 20 }, (_, i) => ({
				...base,
				id: `bg-${i + 2}`,
				status: "done" as const,
				exitCode: 0,
				startedAt: 2_000 + i,
				endedAt: 3_000 + i,
			})),
		];
		const list = formatList(jobs, 5_000);
		const rows = list.split("\n");
		expect(rows[0]).toBe("21 jobs this session · 1 running · 10 shown");
		expect(rows[1]).toContain("bg-1 · running");
		expect(rows[11]).toContain("… and 11 more");
	});
});

describe("widgetModel", () => {
	const now = 1_000_000;
	function runningJob(id: string, startedAt: number, auto = false): Job {
		return {
			id,
			command: `echo ${id}`,
			cwd: "/tmp",
			pid: 123,
			status: "running",
			exitCode: null,
			signal: null,
			logPath: "/dev/null",
			startedAt,
			endedAt: null,
			auto,
			delivered: false,
		};
	}
	function finishedJob(id: string): Job {
		return {
			...runningJob(id, now - 1000),
			status: "done",
			exitCode: 0,
			endedAt: now,
			delivered: true,
		};
	}

	test("only running jobs appear, elapsed relative to now", () => {
		const model = widgetModel(
			[
				finishedJob("bg-1"),
				runningJob("bg-2", now - 65_000),
				runningJob("bg-3", now - 2_000),
			],
			now,
		);
		expect(model.running).toBe(2);
		expect(model.hidden).toBe(0);
		expect(model.rows.map((r) => r.id)).toEqual(["bg-2", "bg-3"]);
		expect(model.rows[0]?.elapsedText).toBe("1m 5s");
		expect(model.rows[1]?.elapsedText).toBe("2s");
	});

	test("rows cap at MAX_WIDGET_ROWS; the rest collapse into hidden", () => {
		const jobs = Array.from({ length: MAX_WIDGET_ROWS + 3 }, (_, i) =>
			runningJob(`bg-${i + 1}`, now),
		);
		const model = widgetModel(jobs, now);
		expect(model.running).toBe(MAX_WIDGET_ROWS + 3);
		expect(model.rows).toHaveLength(MAX_WIDGET_ROWS);
		expect(model.hidden).toBe(3);
	});

	test("empty model clears the widget", () => {
		expect(widgetModel([], now)).toEqual({ running: 0, rows: [], hidden: 0 });
		expect(widgetModel([finishedJob("bg-1")], now).running).toBe(0);
	});

	test("auto flag survives into rows", () => {
		const model = widgetModel([runningJob("bg-9", now - 31_000, true)], now);
		expect(model.rows[0]?.auto).toBe(true);
	});
});

// ── session-isolated registry keys (decision 0013) ─────────────────────────

describe("sessionKeyFor", () => {
	test("same session id → same key; different ids → different keys", () => {
		expect(sessionKeyFor("sess-a", 100)).toBe(sessionKeyFor("sess-a", 200));
		expect(sessionKeyFor("sess-a", 100)).not.toBe(sessionKeyFor("sess-b", 100));
	});

	test("no session id → falls back to host pid (unique per process, /reload-stable)", () => {
		expect(sessionKeyFor(undefined, 42)).toBe("p42");
		expect(sessionKeyFor(undefined, 42)).not.toBe(sessionKeyFor(undefined, 43));
		expect(sessionKeyFor("", 42)).toBe("p42");
	});

	test("hostile id text is sanitized to a safe dir name", () => {
		expect(sessionKeyFor("../../etc", 1)).not.toContain("/");
		expect(sessionKeyFor("../../etc", 1)).not.toContain(".");
		expect(sessionKeyFor("a/b\\c d", 1)).toBe("a_b_c_d");
	});
});

describe("spawnToFile", () => {
	test("an unopenable log path settles the job instead of crashing", async () => {
		// The log dir does not exist — the write stream emits "error" async, and
		// an unhandled 'error' event would take the whole pi host down.
		const logPath = join(dir, "no-such-dir", "bg-1.log");
		const spawned = spawnToFile(
			process.execPath,
			["-e"],
			"console.log('hi')",
			dir,
			process.env,
			logPath,
		);
		const exit = await spawned.exit;
		expect(exit.code).toBe(0);
		expect(existsSync(logPath)).toBe(false);
	});
});

describe("gcSessionDirs", () => {
	test("sweeps only stale siblings; fresh dirs and keepKey survive", () => {
		const parent = mkdtempSync(join(tmpdir(), "sb-gc-"));
		const fresh = join(parent, "fresh-sess");
		const stale = join(parent, "stale-sess");
		const keep = join(parent, "keep-sess");
		for (const d of [fresh, stale, keep]) mkdirSync(d);
		const now = Date.now();
		utimesSync(
			stale,
			new Date(now - 48 * 3600_000),
			new Date(now - 48 * 3600_000),
		);
		gcSessionDirs(parent, "keep-sess", 24 * 3600_000, now);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(keep)).toBe(true);
		rmSync(parent, { recursive: true, force: true });
	});

	test("a stale dir whose owner process is alive is never swept", () => {
		const parent = mkdtempSync(join(tmpdir(), "sb-gc-live-"));
		const live = join(parent, "live-sess");
		const dead = join(parent, "dead-sess");
		for (const d of [live, dead]) mkdirSync(d);
		// A live session that simply ran nothing for two days: old mtime, but
		// the host process still owns the dir and needs its logs/ to exist.
		writeFileSync(join(live, "owner.pid"), String(process.pid));
		// pid 1 is init/launchd, never our host; stand-in for a dead owner is a
		// pid we know is gone, so use an unused high pid instead.
		writeFileSync(join(dead, "owner.pid"), "2147483645");
		const now = Date.now();
		const old = new Date(now - 48 * 3600_000);
		utimesSync(live, old, old);
		utimesSync(dead, old, old);
		gcSessionDirs(parent, "keep-sess", 24 * 3600_000, now);
		expect(existsSync(live)).toBe(true);
		expect(existsSync(dead)).toBe(false);
		rmSync(parent, { recursive: true, force: true });
	});

	test("a registry claims its dir for the running process", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-own-"));
		new JobRegistry(base);
		expect(readFileSync(join(base, "owner.pid"), "utf8")).toBe(
			String(process.pid),
		);
		// The claim must not be mistaken for a job sidecar on load.
		expect(new JobRegistry(base).load()).toHaveLength(0);
		rmSync(base, { recursive: true, force: true });
	});
});
