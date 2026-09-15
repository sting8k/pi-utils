/**
 * Unit tests for the edit override's self-written diff (US-003): hunk
 * computation, rendering, and the unified patch emitter. No git anywhere.
 */
import { describe, expect, test } from "bun:test";
import {
	countChanges,
	diffHunks,
	formatDiffs,
	unifiedPatch,
} from "../src/edit/diff.ts";

describe("diffHunks", () => {
	test("single line modification", () => {
		const hunks = diffHunks("a\nb\nc\n", "a\nX\nc\n");
		expect(hunks).toEqual([
			{ oldStart: 2, newStart: 2, oldLines: ["b"], newLines: ["X"] },
		]);
	});

	test("insertion and deletion are separate hunks", () => {
		const hunks = diffHunks("a\nb\n", "a\nx\ny\nb\n");
		expect(hunks).toEqual([
			{ oldStart: 2, newStart: 2, oldLines: [], newLines: ["x", "y"] },
		]);
		const del = diffHunks("a\nb\nc\n", "a\nc\n");
		expect(del).toEqual([
			{ oldStart: 2, newStart: 2, oldLines: ["b"], newLines: [] },
		]);
	});

	test("identical content produces no hunks", () => {
		expect(diffHunks("a\nb\n", "a\nb\n")).toEqual([]);
	});

	test("creation and deletion of whole content", () => {
		expect(diffHunks("", "a\nb\n")).toEqual([
			{ oldStart: 1, newStart: 1, oldLines: [], newLines: ["a", "b"] },
		]);
		expect(diffHunks("a\nb\n", "")).toEqual([
			{ oldStart: 1, newStart: 1, oldLines: ["a", "b"], newLines: [] },
		]);
	});
});

describe("formatDiffs (ported render)", () => {
	test("renders the header, ranges, and +/- lines", () => {
		const rendered = formatDiffs([
			{ oldStart: 2, newStart: 2, oldLines: ["b"], newLines: ["X", "Y"] },
		]);
		expect(rendered).toBe("── diff ──\n:2-3\n- b\n+ X\n+ Y");
	});

	test("empty diff renders empty", () => {
		expect(formatDiffs([])).toBe("");
	});
});

describe("countChanges", () => {
	test("counts additions and removals", () => {
		expect(
			countChanges([
				{ oldStart: 1, newStart: 1, oldLines: ["a", "b"], newLines: ["x"] },
			]),
		).toEqual({ additions: 1, removals: 2 });
	});
});

describe("unifiedPatch", () => {
	test("single file patch with context lines", () => {
		const patch = unifiedPatch([
			{
				path: "a.txt",
				oldContent: "1\n2\n3\n4\n5\n6\n7\n",
				newContent: "1\n2\n3\n4\n5\nsix\n7\n",
			},
		]);
		expect(patch).toBe(
			[
				"--- a/a.txt",
				"+++ b/a.txt",
				"@@ -3,5 +3,5 @@",
				" 3",
				" 4",
				" 5",
				"-6",
				"+six",
				" 7",
			].join("\n"),
		);
	});

	test("multi-file patches concatenate", () => {
		const patch = unifiedPatch([
			{ path: "a.txt", oldContent: "old\n", newContent: "new\n" },
			{ path: "b.txt", oldContent: "x\n", newContent: "y\n" },
		]);
		expect(patch).toBe(
			[
				"--- a/a.txt",
				"+++ b/a.txt",
				"@@ -1,1 +1,1 @@",
				"-old",
				"+new",
				"--- a/b.txt",
				"+++ b/b.txt",
				"@@ -1,1 +1,1 @@",
				"-x",
				"+y",
			].join("\n"),
		);
	});

	test("no change → empty string; creation uses the 0 sentinel", () => {
		expect(
			unifiedPatch([{ path: "a.txt", oldContent: "x\n", newContent: "x\n" }]),
		).toBe("");
		expect(
			unifiedPatch([{ path: "new.txt", oldContent: "", newContent: "a\nb\n" }]),
		).toContain("@@ -0,0 +1,2 @@");
	});
});
