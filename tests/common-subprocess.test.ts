import { describe, expect, test } from "bun:test";
import { runProcess } from "../src/common/subprocess.ts";

describe("runProcess", () => {
	test("captures stdout, stderr and exit code", async () => {
		const res = await runProcess("/bin/echo", ["hello"], {});
		expect(res.code).toBe(0);
		expect(res.stdout.toString("utf8").trim()).toBe("hello");
		expect(res.aborted).toBe(false);
		expect(res.timedOut).toBe(false);
	});

	test("nonzero exit code is reported, not thrown", async () => {
		const res = await runProcess("/usr/bin/env", ["false"], {});
		expect(res.code).toBe(1);
	});

	test("timeout kills the process and marks timedOut", async () => {
		const res = await runProcess("/bin/sleep", ["5"], {
			timeoutMs: 150,
			graceMs: 200,
		});
		expect(res.timedOut).toBe(true);
		expect(res.code).not.toBe(0);
	});

	test("abort signal kills the process and marks aborted", async () => {
		const controller = new AbortController();
		const promise = runProcess("/bin/sleep", ["5"], {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		const res = await promise;
		expect(res.aborted).toBe(true);
		expect(res.timedOut).toBe(false);
	});

	test("stdout over the cap kills the child and marks truncated", async () => {
		// 10KB of output, cap at 1KB.
		const res = await runProcess("/usr/bin/yes", ["0123456789"], {
			maxOutputBytes: 1024,
			timeoutMs: 5000,
		});
		expect(res.stdoutTruncated).toBe(true);
		expect(res.stdout.length).toBeLessThanOrEqual(2048);
	}, 10_000);
});
