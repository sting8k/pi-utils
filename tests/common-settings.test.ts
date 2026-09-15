import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	settingsFilePath,
} from "../src/common/settings.ts";

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-utils-settings-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadSettings", () => {
	test("scaffolds the file with full defaults on first run", () => {
		const result = loadSettings(dir);
		expect(result.created).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		const onDisk = JSON.parse(readFileSync(settingsFilePath(dir), "utf8"));
		expect(onDisk).toEqual(DEFAULT_SETTINGS);
	});

	test("second run reads the file without recreating it", () => {
		const result = loadSettings(dir);
		expect(result.created).toBe(false);
		expect(result.settings.fsSearch.grepMaxMatches).toBe(250);
	});

	test("respects user edits, fills missing keys with defaults", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: { grepMaxMatches: 10 },
				shellBg: { tailBytes: 512 },
			}),
		);
		const result = loadSettings(dir);
		expect(result.created).toBe(false);
		expect(result.settings.fsSearch.grepMaxMatches).toBe(10); // kept
		expect(result.settings.fsSearch.noIgnore).toBe(true); // default filled in
		expect(result.settings.shellBg.tailBytes).toBe(512); // kept
		expect(result.settings.shellBg.autoBackgroundMs).toBe(30_000); // default filled in
	});

	test("invalid values warn and fall back to defaults", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: { grepMaxMatches: "lots" },
				shellBg: { autoBackgroundMs: -5 },
			}),
		);
		const result = loadSettings(dir);
		expect(result.settings.fsSearch.grepMaxMatches).toBe(250);
		expect(result.settings.shellBg.autoBackgroundMs).toBe(30_000);
		expect(
			result.warnings.some((w) => w.includes("fsSearch.grepMaxMatches")),
		).toBe(true);
		expect(
			result.warnings.some((w) => w.includes("shellBg.autoBackgroundMs")),
		).toBe(true);
	});

	test("unparseable file falls back entirely to defaults with a warning", () => {
		writeFileSync(settingsFilePath(dir), "{ not json");
		const result = loadSettings(dir);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toContain("parse error");
	});

	test("non-object file warns", () => {
		writeFileSync(settingsFilePath(dir), "[1,2,3]");
		const result = loadSettings(dir);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		expect(result.warnings[0]).toContain("not a JSON object");
	});
});

describe("loadSettings — bashRouter (Amendment A1)", () => {
	test("pre-amendment file without the section picks up the default silently", () => {
		writeFileSync(
			settingsFilePath(dir),
			// Pre-amendment shape: fsSearch/shellBg present, bashRouter absent.
			JSON.stringify({ fsSearch: {}, shellBg: {} }),
		);
		const result = loadSettings(dir);
		expect(result.settings.bashRouter.unwrapPrefixes).toEqual(["rtk"]);
		expect(result.warnings).toEqual([]);
	});

	test("custom whitelist is kept; empty list disables unwrap", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: {},
				shellBg: {},
				bashRouter: { unwrapPrefixes: ["time", "env"] },
			}),
		);
		expect(loadSettings(dir).settings.bashRouter.unwrapPrefixes).toEqual([
			"time",
			"env",
		]);
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: {},
				shellBg: {},
				bashRouter: { unwrapPrefixes: [] },
			}),
		);
		const disabled = loadSettings(dir);
		expect(disabled.settings.bashRouter.unwrapPrefixes).toEqual([]);
		expect(disabled.warnings).toEqual([]);
	});

	test("invalid unwrapPrefixes warns and falls back", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({ bashRouter: { unwrapPrefixes: "rtk" } }),
		);
		const result = loadSettings(dir);
		expect(result.settings.bashRouter.unwrapPrefixes).toEqual(["rtk"]);
		expect(
			result.warnings.some((w) => w.includes("bashRouter.unwrapPrefixes")),
		).toBe(true);
	});
});

describe("loadSettings — disabledTools (US-002)", () => {
	test("valid list parses; duplicates dedupe", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: {},
				shellBg: {},
				disabledTools: ["grep", "glob", "grep"],
			}),
		);
		const result = loadSettings(dir);
		expect(result.settings.disabledTools).toEqual(["grep", "glob"]);
		expect(result.warnings).toEqual([]);
	});

	test("missing key picks up the default silently (no warning)", () => {
		writeFileSync(
			settingsFilePath(dir),
			// Pre-US-002 shape: no disabledTools key.
			JSON.stringify({ fsSearch: {}, shellBg: {} }),
		);
		const result = loadSettings(dir);
		expect(result.settings.disabledTools).toEqual(["grep", "glob"]);
		expect(result.warnings).toEqual([]);
	});

	test("non-array warns and falls back to the default", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({ fsSearch: {}, shellBg: {}, disabledTools: "grep" }),
		);
		const result = loadSettings(dir);
		expect(result.settings.disabledTools).toEqual(["grep", "glob"]);
		expect(
			result.warnings.some((w) => w.includes('"disabledTools" invalid')),
		).toBe(true);
	});

	test("unknown entry warns by name and is dropped; valid siblings survive", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: {},
				shellBg: {},
				disabledTools: ["grpe", "glob", 42],
			}),
		);
		const result = loadSettings(dir);
		expect(result.settings.disabledTools).toEqual(["glob"]);
		expect(result.warnings.some((w) => w.includes('"grpe"'))).toBe(true);
		expect(result.warnings.some((w) => w.includes("42"))).toBe(true);
	});
});

describe("loadSettings — repair pass (owner decision 2026-09-15)", () => {
	test("(a) v0.1.0-era file gains bashRouter/edit/disabledTools; existing values untouched", () => {
		// bean's real file shape at v0.1.0: only the two original sections.
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: { globMaxResults: 42 },
				shellBg: { autoBackgroundMs: 45_000 },
			}),
		);
		const result = loadSettings(dir);
		expect(result.created).toBe(false);
		expect(result.settings.bashRouter.unwrapPrefixes).toEqual(["rtk"]);
		expect(result.settings.edit).toEqual({ lang: "python", timeoutSec: 10 });
		expect(result.settings.disabledTools).toEqual(["grep", "glob"]);
		// Custom values survive verbatim.
		expect(result.settings.fsSearch.globMaxResults).toBe(42);
		expect(result.settings.shellBg.autoBackgroundMs).toBe(45_000);

		const onDisk = JSON.parse(readFileSync(settingsFilePath(dir), "utf8"));
		expect(Object.keys(onDisk).sort()).toEqual([
			"bashRouter",
			"disabledTools",
			"edit",
			"fsSearch",
			"shellBg",
		]);
		expect(onDisk.fsSearch.globMaxResults).toBe(42);
		expect(onDisk.shellBg.autoBackgroundMs).toBe(45_000);
		expect(result.repaired.sort()).toEqual([
			"bashRouter",
			"disabledTools",
			"edit",
			"fsSearch.graceMs",
			"fsSearch.grepMaxLineBytes",
			"fsSearch.grepMaxMatches",
			"fsSearch.noIgnore",
			"fsSearch.rawOutputMaxBytes",
			"fsSearch.timeoutMs",
			"shellBg.killGraceMs",
			"shellBg.tailBytes",
		]);
	});

	test("(b) repair fills missing keys inside existing sections, verbatim customs kept", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({ fsSearch: { globMaxResults: 42 } }),
		);
		const result = loadSettings(dir);
		expect(result.settings.fsSearch.globMaxResults).toBe(42);
		expect(result.settings.fsSearch.graceMs).toBe(3_000); // default filled
		expect(result.repaired).toContain("fsSearch.graceMs");
	});

	test("(c) unknown user keys are preserved through the repair write", () => {
		writeFileSync(
			settingsFilePath(dir),
			JSON.stringify({
				fsSearch: { globMaxResults: 42, myComment: "hands off" },
				futureSection: { whatever: true },
			}),
		);
		loadSettings(dir);
		const onDisk = JSON.parse(readFileSync(settingsFilePath(dir), "utf8"));
		expect(onDisk.fsSearch.myComment).toBe("hands off");
		expect(onDisk.futureSection).toEqual({ whatever: true });
	});

	test("(d) complete file: no repair, no rewrite", () => {
		const original = `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`;
		writeFileSync(settingsFilePath(dir), original);
		const result = loadSettings(dir);
		expect(result.repaired).toEqual([]);
		expect(readFileSync(settingsFilePath(dir), "utf8")).toBe(original);
	});

	test("(e) parse error: defaults in memory, broken file NOT overwritten", () => {
		writeFileSync(settingsFilePath(dir), "{ not json");
		const result = loadSettings(dir);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		expect(result.repaired).toEqual([]);
		expect(readFileSync(settingsFilePath(dir), "utf8")).toBe("{ not json");
	});
});
