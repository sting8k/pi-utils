/**
 * Unit tests for the edit override's script core (US-003): snapshot/rollback
 * of declared paths, interpreter spawn (code on stdin), output caps + spill,
 * timeout, and no-op detection. Uses node scripts (always available); one
 * python test runs when python3 exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEditScript } from "../src/edit/run-script.ts";
import { snapshotPaths } from "../src/edit/snapshot.ts";

let root = "";

beforeAll(() => {
	root = join(tmpdir(), `pi-utils-edit-${process.pid}-${Date.now()}`);
	mkdirSync(root, { recursive: true });
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const node = (body: string): string => body;

describe("snapshotPaths", () => {
	test("captures content and absence; restore reverts bytes and deletes created files", () => {
		const existing = join(root, "snap-existing.txt");
		writeFileSync(existing, "before\n");
		const absent = join(root, "snap-absent.txt");

		const snapshot = snapshotPaths([existing, absent]);
		expect(snapshot.warnings).toEqual([]);

		writeFileSync(existing, "changed\n");
		writeFileSync(absent, "created\n");
		snapshot.restore();

		expect(readFileSync(existing, "utf8")).toBe("before\n");
		expect(existsSync(absent)).toBe(false);
	});
});

describe("runEditScript — success paths", () => {
	test("node script modifies a declared file; change classified as modified", async () => {
		const file = join(root, "mod.txt");
		writeFileSync(file, "one\ntwo\nthree\n");
		const outcome = await runEditScript({
			code: node(
				`const fs = require("node:fs");\nconst p = ${JSON.stringify(file)};\nfs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("two", "TWO"));`,
			),
			paths: [file],
			lang: "node",
			timeoutSec: 10,
			cwd: root,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changes).toHaveLength(1);
		expect(outcome.changes[0]).toMatchObject({
			kind: "modified",
			oldContent: "one\ntwo\nthree\n",
			newContent: "one\nTWO\nthree\n",
		});
		expect(outcome.exitCode).toBe(0);
	});

	test("python script runs when python3 is present", async () => {
		const file = join(root, "py.txt");
		writeFileSync(file, "hello\n");
		const outcome = await runEditScript({
			code: `from pathlib import Path\np = Path(${JSON.stringify(file)})\np.write_text(p.read_text().upper())`,
			paths: [file],
			lang: "python",
			timeoutSec: 10,
			cwd: root,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(readFileSync(file, "utf8")).toBe("HELLO\n");
		expect(outcome.changes[0]?.kind).toBe("modified");
	});

	test("creation and deletion of declared paths are reported", async () => {
		const created = join(root, "created.txt");
		const deleted = join(root, "deleted.txt");
		writeFileSync(deleted, "doomed\n");
		const outcome = await runEditScript({
			code: node(
				`const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(created)}, "new file\\n");\nfs.rmSync(${JSON.stringify(deleted)});`,
			),
			paths: [created, deleted],
			lang: "node",
			timeoutSec: 10,
			cwd: root,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changes.map((c) => c.kind).sort()).toEqual([
			"created",
			"deleted",
		]);
	});

	test("stdout/stderr are captured; no-op exit 0 yields zero changes", async () => {
		const file = join(root, "noop.txt");
		writeFileSync(file, "same\n");
		const outcome = await runEditScript({
			code: node(`console.log("to stdout");\nconsole.error("to stderr");`),
			paths: [file],
			lang: "node",
			timeoutSec: 10,
			cwd: root,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.stdout).toContain("to stdout");
		expect(outcome.stderr).toContain("to stderr");
		expect(outcome.changes).toEqual([]);
	});

	test("output over the cap spills to a temp file", async () => {
		const outcome = await runEditScript({
			code: node(`for (let i = 0; i < 500; i++) console.log("x".repeat(80));`),
			paths: [join(root, "spill-target.txt")],
			lang: "node",
			timeoutSec: 10,
			cwd: root,
			maxOutputBytes: 1024,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.stdoutTruncated).toBe(true);
		expect(outcome.spillPath).toBeTruthy();
	});
});

describe("runEditScript — failure paths", () => {
	test("nonzero exit rolls back bytes and deletes script-created files", async () => {
		const existing = join(root, "rollback.txt");
		writeFileSync(existing, "original\n");
		const created = join(root, "rollback-created.txt");

		const outcome = await runEditScript({
			code: node(
				`const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(existing)}, "dirty\\n");\nfs.writeFileSync(${JSON.stringify(created)}, "leftover\\n");\nprocess.exit(3);`,
			),
			paths: [existing, created],
			lang: "node",
			timeoutSec: 10,
			cwd: root,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.rolledBack).toBe(true);
		expect(outcome.exitCode).toBe(3);
		expect(outcome.dirtyBeforeRestore.sort()).toEqual(
			[existing, created].sort(),
		);
		expect(readFileSync(existing, "utf8")).toBe("original\n");
		expect(existsSync(created)).toBe(false);
	});

	test("timeout kills the script and rolls back", async () => {
		const file = join(root, "timeout.txt");
		writeFileSync(file, "safe\n");
		const outcome = await runEditScript({
			code: node(
				`const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(file)}, "touched\\n");\nsetTimeout(() => {}, 30000);`,
			),
			paths: [file],
			lang: "node",
			timeoutSec: 1,
			cwd: root,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.timedOut).toBe(true);
		expect(outcome.rolledBack).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("safe\n");
	});

	test("abort signal kills the script and rolls back", async () => {
		const file = join(root, "abort.txt");
		writeFileSync(file, "safe\n");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);

		const outcome = await runEditScript({
			code: node(
				`const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(file)}, "touched\\n");\nsetInterval(() => {}, 1000);`,
			),
			paths: [file],
			lang: "node",
			timeoutSec: 30,
			cwd: root,
			signal: controller.signal,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.aborted).toBe(true);
		expect(outcome.rolledBack).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("safe\n");
	});

	test("missing interpreter chain yields the lang:node hint", async () => {
		// Both candidates ENOENT → the chain must end in the lang:"node"
		// hint, not a raw ENOENT.
		const outcome = await runEditScript({
			code: "print(1)",
			paths: [join(root, "no-interpreter.txt")],
			lang: "python",
			timeoutSec: 10,
			cwd: root,
			interpreterCandidates: [
				["/nonexistent/python3", "-"],
				["/nonexistent/python", "-"],
			],
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.spawnError).toContain('pass lang:"node"');
		expect(outcome.rolledBack).toBe(true);
	});
});
