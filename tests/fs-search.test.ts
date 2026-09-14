import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRg } from "../src/common/rg-resolver.ts";
import {
	DEFAULT_SETTINGS,
	type FsSearchSettings,
} from "../src/common/settings.ts";
import { runGlob } from "../src/fs-search/glob-core.ts";
import { runGrep } from "../src/fs-search/grep-core.ts";

let root = "";
let rg = "";
const settings: FsSearchSettings = DEFAULT_SETTINGS.fsSearch;

const T0 = 1_700_000_000_000; // deterministic fake mtimes (ms)

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-utils-fssearch-"));
	rg = resolveRg();

	mkdirSync(join(root, "sub"));
	mkdirSync(join(root, ".git"));

	writeFileSync(join(root, "old.md"), "# old\ncontains preset alpha\n");
	writeFileSync(join(root, "sub", "new.md"), "# new\ncontains preset beta\n");
	writeFileSync(join(root, ".hidden.md"), "hidden preset gamma\n");
	writeFileSync(join(root, "ignored.md"), "ignored preset delta\n");
	writeFileSync(join(root, ".gitignore"), "ignored.md\n");
	writeFileSync(
		join(root, "notes.txt"),
		"plain text line one\nplain text line two\n",
	);
	writeFileSync(join(root, ".git", "config"), "preset epsilon\n");

	// old.md oldest, then notes.txt, then .hidden.md, then ignored.md, then sub/new.md newest.
	const times: [string, number][] = [
		["old.md", T0],
		["notes.txt", T0 + 1000],
		[".hidden.md", T0 + 2000],
		["ignored.md", T0 + 3000],
		[join("sub", "new.md"), T0 + 4000],
	];
	for (const [rel, time] of times) {
		utimesSync(join(root, rel), new Date(time), new Date(time));
	}
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("runGlob", () => {
	test("matches basenames at any depth, mtime ascending", async () => {
		const result = await runGlob(rg, { pattern: "*.md" }, settings, root);
		const lines = result.text.split("\n");
		expect(lines[0]).toBe("old.md");
		expect(lines[1]).toBe(".hidden.md");
		expect(lines[2]).toBe("ignored.md");
		expect(lines[3]).toBe(join("sub", "new.md"));
	});

	test("includes hidden and gitignored files, excludes .git", async () => {
		const result = await runGlob(rg, { pattern: "*" }, settings, root);
		expect(result.text).toContain(".hidden.md");
		expect(result.text).toContain("ignored.md");
		expect(result.text).not.toContain(".git/");
		expect(result.text).toContain(".gitignore");
	});

	test("anchored pattern stays under its path", async () => {
		const result = await runGlob(rg, { pattern: "sub/*" }, settings, root);
		expect(result.text).toContain("new.md");
		expect(result.text).not.toContain("old.md");
	});

	test("no matches is an empty success", async () => {
		const result = await runGlob(rg, { pattern: "*.nomatch" }, settings, root);
		expect(result.text).toBe("No files found.");
		expect(result.total).toBe(0);
	});

	test("over-cap results spill to a file with a locator", async () => {
		const tight = { ...settings, globMaxResults: 2 };
		const result = await runGlob(rg, { pattern: "*" }, tight, root);
		expect(result.total).toBeGreaterThan(2);
		expect(result.text).toContain("Showing 2 of");
		expect(result.text).toContain("Full list:");
		expect(result.spillPath).toBeDefined();
	});

	test("missing path fails with SEARCH_FAILED", async () => {
		await expect(
			runGlob(rg, { pattern: "*", path: "nope" }, settings, root),
		).rejects.toThrow("SEARCH_FAILED");
	});
});

describe("runGrep", () => {
	test("finds matches across hidden and gitignored files with line numbers", async () => {
		const result = await runGrep(rg, { pattern: "preset" }, settings, root);
		expect(result.matchCount).toBe(4); // old, new, hidden, ignored — .git excluded
		expect(result.fileCount).toBe(4);
		expect(result.text).toContain("old.md:2: contains preset alpha");
		expect(result.text).toContain("sub/new.md:2: contains preset beta");
		expect(result.text).toContain(".hidden.md:1: hidden preset gamma");
		expect(result.text).toContain("ignored.md:1: ignored preset delta");
		expect(result.text).not.toContain("preset epsilon");
	});

	test("no matches is a success with a clear message", async () => {
		const result = await runGrep(
			rg,
			{ pattern: "definitely-not-there" },
			settings,
			root,
		);
		expect(result.text).toBe("No matches found.");
		expect(result.matchCount).toBe(0);
	});

	test("include filters by glob", async () => {
		const result = await runGrep(
			rg,
			{ pattern: "preset", include: "*.txt" },
			settings,
			root,
		);
		expect(result.matchCount).toBe(0);
		const resultMd = await runGrep(
			rg,
			{ pattern: "preset", include: "*.md" },
			settings,
			root,
		);
		expect(resultMd.matchCount).toBe(4);
	});

	test("include rejects comma lists and negations", async () => {
		await expect(
			runGrep(rg, { pattern: "x", include: "a,b" }, settings, root),
		).rejects.toThrow("SEARCH_INVALID_PATTERN");
		await expect(
			runGrep(rg, { pattern: "x", include: "!a" }, settings, root),
		).rejects.toThrow("SEARCH_INVALID_PATTERN");
	});

	test("invalid regex maps to SEARCH_INVALID_PATTERN", async () => {
		await expect(
			runGrep(rg, { pattern: "([unclosed" }, settings, root),
		).rejects.toThrow("SEARCH_INVALID_PATTERN");
	});

	test("literal mode treats pattern as plain text", async () => {
		const result = await runGrep(
			rg,
			{ pattern: "line one", literal: true },
			settings,
			root,
		);
		expect(result.matchCount).toBe(1);
		await expect(
			runGrep(rg, { pattern: "([unclosed", literal: true }, settings, root),
		).resolves.toMatchObject({ matchCount: 0 });
	});

	test("limit stops early and notices it", async () => {
		const result = await runGrep(
			rg,
			{ pattern: "preset", limit: 2 },
			settings,
			root,
		);
		expect(result.matchCount).toBe(2);
		expect(result.matchLimitReached).toBe(true);
		expect(result.text).toContain("limit reached");
		expect(result.text).toContain("limit=4");
	});

	test("context lines are included when requested", async () => {
		const result = await runGrep(
			rg,
			{ pattern: "line two", context: 1 },
			settings,
			root,
		);
		expect(result.text).toContain("notes.txt-1- plain text line one");
		expect(result.text).toContain("notes.txt:2: plain text line two");
	});

	test("noIgnore:false respects gitignore", async () => {
		const result = await runGrep(
			rg,
			{ pattern: "preset", noIgnore: false },
			settings,
			root,
		);
		expect(result.matchCount).toBe(3); // old, new, hidden — ignored.md excluded
		expect(result.text).not.toContain("ignored.md");
	});

	test("timeout aborts with SEARCH_ABORTED", async () => {
		// rg reading a FIFO with no writer blocks forever — deterministic timeout.
		const fifo = join(root, "slowpipe");
		execSync(`mkfifo '${fifo}'`);
		const slow = { ...settings, timeoutMs: 400 };
		try {
			await expect(
				runGrep(rg, { pattern: "x", path: fifo }, slow, root),
			).rejects.toThrow("SEARCH_ABORTED");
		} finally {
			rmSync(fifo, { force: true });
		}
	});
});
