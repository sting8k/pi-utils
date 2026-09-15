/**
 * Unit tests for the edit mutation queue (US-003 Execution §2): same-path
 * windows serialize so diffs never misattribute the other call's writes,
 * failed calls release their locks, and disjoint paths still run in
 * parallel.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPathLocks } from "../src/edit/mutation-queue.ts";
import { runEditScript } from "../src/edit/run-script.ts";

let root = "";

beforeAll(() => {
	root = join(tmpdir(), `pi-utils-editq-${process.pid}-${Date.now()}`);
	mkdirSync(root, { recursive: true });
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const nodeWrite = (file: string, content: string): string =>
	`const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)});`;

const run = (code: string, paths: string[]) =>
	runEditScript({
		code,
		paths,
		lang: "node",
		timeoutSec: 10,
		cwd: root,
	});

describe("withPathLocks", () => {
	test("interleaved same-path calls: the no-op caller diffs only its own window", async () => {
		const file = join(root, "race.txt");
		writeFileSync(file, "base\n");

		// A writes; B writes nothing. Order of completion must not matter —
		// B's window either precedes or follows A's whole window, never
		// overlaps it, so B's diff stays empty.
		const [a, b] = await Promise.all([
			withPathLocks([file], () =>
				run(nodeWrite(file, "written by A\n"), [file]),
			),
			withPathLocks([file], () => run("console.log('noop')", [file])),
		]);

		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) {
			expect(b.changes).toEqual([]); // B's diff: only B's writes — none
			expect(a.changes[0]?.kind).toBe("modified");
		}
		expect(readFileSync(file, "utf8")).toBe("written by A\n");
	});

	test("failed call releases locks — the queued caller still runs", async () => {
		const file = join(root, "release.txt");
		writeFileSync(file, "base\n");

		const [a, b] = await Promise.all([
			withPathLocks([file], () =>
				run(`${nodeWrite(file, "dirty\n")}\nprocess.exit(1);`, [file]),
			),
			withPathLocks([file], () =>
				run(nodeWrite(file, "written by B\n"), [file]),
			),
		]);

		expect(a.ok).toBe(false); // rolled back
		expect(b.ok).toBe(true);
		if (b.ok) {
			expect(b.changes[0]?.kind).toBe("modified");
		}
		// Either order: B's write lands last among the two serialized windows.
		expect(["base\n", "written by B\n"]).toContain(readFileSync(file, "utf8"));
	});

	test("a throwing window releases its locks too", async () => {
		const file = join(root, "throw.txt");
		writeFileSync(file, "base\n");

		const throwing = withPathLocks([file], async () => {
			throw new Error("boom");
		});
		const next = withPathLocks([file], () =>
			run(nodeWrite(file, "after\n"), [file]),
		);
		await expect(throwing).rejects.toThrow("boom");
		await expect(next).resolves.toBeTruthy();
	});

	test("disjoint paths run in parallel", async () => {
		const a = join(root, "parallel-a.txt");
		const b = join(root, "parallel-b.txt");

		const start = Date.now();
		await Promise.all([
			withPathLocks([a], () =>
				run(
					`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(a)}, "A\\n"), 400);`,
					[a],
				),
			),
			withPathLocks([b], () =>
				run(
					`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(b)}, "B\\n"), 400);`,
					[b],
				),
			),
		]);
		const elapsed = Date.now() - start;

		expect(readFileSync(a, "utf8")).toBe("A\n");
		expect(readFileSync(b, "utf8")).toBe("B\n");
		// Two 400ms scripts on disjoint paths must overlap, not queue.
		expect(elapsed).toBeLessThan(700);
	});

	test("multi-path callers acquire in sorted order and both complete", async () => {
		const file1 = join(root, "multi-1.txt");
		const file2 = join(root, "multi-2.txt");
		writeFileSync(file1, "1\n");
		writeFileSync(file2, "2\n");

		// Overlapping path sets acquired in opposite declaration orders.
		const [x, y] = await Promise.all([
			withPathLocks([file2, file1], () =>
				run(nodeWrite(file1, "1-x\n"), [file2, file1]),
			),
			withPathLocks([file1, file2], () =>
				run(nodeWrite(file2, "2-y\n"), [file1, file2]),
			),
		]);
		expect(x.ok).toBe(true);
		expect(y.ok).toBe(true);
	});
});
