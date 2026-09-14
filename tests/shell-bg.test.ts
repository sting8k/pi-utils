import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatList, header } from "../src/shell-bg/format.ts";
import {
	backgroundedResult,
	DELIVERY_TYPE,
	deliveryMessage,
} from "../src/shell-bg/pending.ts";
import { JobRegistry } from "../src/shell-bg/registry.ts";
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

	test("missing file yields empty", async () => {
		const tail = await readTail(join(dir, "missing.log"), 100);
		expect(tail.text).toBe("");
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
		expect(r.text).toContain("shell_status");
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
		expect(r.text).toContain("headless run");
		expect(r.details.pollRequired).toBe(true);
	});

	test("delivery message wraps the body with the id", () => {
		const m = deliveryMessage("bg-1", "exit 0\nok");
		expect(m).toContain('<shell_bg_result id="bg-1">');
		expect(m).toContain("just finished");
		expect(DELIVERY_TYPE).toBe("pi-utils-shell-bg-result");
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
	});
});
