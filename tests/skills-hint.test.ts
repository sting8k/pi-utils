import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildHintIndex,
	buildQuery,
	createActivityLog,
	HINT_MAX,
	rankHints,
} from "../src/skills/hint.ts";
import type { VisibleSkill } from "../src/skills/index-transform.ts";
import {
	loadUsage,
	recordUse,
	USAGE_HALF_LIFE_MS,
} from "../src/skills/usage.ts";

const skill = (name: string, description: string, tags: string[] = []) =>
	({
		name,
		description,
		tags,
		location: `/s/${name}/SKILL.md`,
	}) as VisibleSkill;

// Filler gives IDF something to work with (rare words must be rare).
const corpus: VisibleSkill[] = [
	skill("acme-guilds-status-list", "Use when listing guilds in acme"),
	skill("acme-plugin-static-assets", "Use when a acme plugin serves assets"),
	skill(
		"rebase-conflict-extracted-code",
		"Use when a rebase conflict moves code",
	),
	skill("docx", "Use when creating word documents", ["office"]),
	...Array.from({ length: 30 }, (_, i) =>
		skill(`filler-${i}`, `Use when handling thing number ${i} carefully`),
	),
];

describe("tier-2 hint ranking (US-005)", () => {
	const index = buildHintIndex(corpus);

	test("relevant prompt → ≤HINT_MAX best matches; unrelated prompt → none", () => {
		const hits = rankHints(
			index,
			buildQuery("spawn a peer in acme and list the guilds", new Set()),
			new Set(),
		);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.length).toBeLessThanOrEqual(HINT_MAX);
		expect(hits[0]?.name).toBe("acme-guilds-status-list");

		expect(
			rankHints(index, buildQuery("what is the weather", new Set()), new Set()),
		).toEqual([]);
	});

	test("language-neutral signals (cwd, tool names) carry a non-English prompt; exclude drops repeats", () => {
		const log = createActivityLog();
		log.note("bash", { command: "FOO=1 git rebase main" });
		log.note("read", { path: "/x/y.ts" }); // builtin tool name adds nothing
		const query = buildQuery(
			"làm tiếp đi",
			log.tokens("/Users/me/work/acme-guilds"),
		);
		const hits = rankHints(index, query, new Set());
		expect(hits.map((h) => h.name)).toContain("acme-guilds-status-list");
		const again = rankHints(index, query, new Set(["acme-guilds-status-list"]));
		expect(again.map((h) => h.name)).not.toContain("acme-guilds-status-list");
	});
});

describe("cross-session usage file (US-005)", () => {
	let dir = "";
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-utils-usage-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("persists across loads, decays by half-life, prunes stale", () => {
		const file = join(dir, "usage.json");
		const t0 = 1_000_000_000_000;
		recordUse(file, "a", t0);
		recordUse(file, "a", t0);
		recordUse(file, "b", t0);
		expect(loadUsage(file, t0).scores.get("a")).toBeCloseTo(2);
		expect(
			loadUsage(file, t0 + USAGE_HALF_LIFE_MS).scores.get("a"),
		).toBeCloseTo(1);
		// ~7 half-lives later "b" (score 1) is below the prune floor on next write.
		recordUse(file, "c", t0 + 7 * USAGE_HALF_LIFE_MS);
		const names = [
			...loadUsage(file, t0 + 7 * USAGE_HALF_LIFE_MS).scores.keys(),
		];
		expect(names).toEqual(["c"]);
	});

	test("corrupt file → empty usage + warning, never throws; next use rewrites it", () => {
		const file = join(dir, "bad.json");
		writeFileSync(file, "{not json");
		const loaded = loadUsage(file, Date.now());
		expect(loaded.scores.size).toBe(0);
		expect(loaded.warning).toBeTruthy();
		recordUse(file, "a", Date.now());
		expect(JSON.parse(readFileSync(file, "utf8")).skills.a.score).toBe(1);
		expect(loadUsage(file, Date.now()).warning).toBeUndefined();
		expect(loadUsage(join(dir, "missing.json"), 0).warning).toBeUndefined();
	});
});
