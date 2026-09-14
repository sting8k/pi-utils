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
