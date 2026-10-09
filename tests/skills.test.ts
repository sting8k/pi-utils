import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { loadSettings } from "../src/common/settings.ts";
import {
	parseFrontmatterLenient,
	parseSkillFile,
	validateCreate,
} from "../src/skills/frontmatter.ts";
import { createRequiresChecker, createSeenMap } from "../src/skills/guard.ts";
import { createNudgeTracker } from "../src/skills/nudge.ts";
import {
	createSkill,
	deleteSkill,
	listCategories,
	locateSkill,
	moveSkill,
	patchSkill,
	resolveSkillMdPath,
	SKILL_MD,
	skillDir,
} from "../src/skills/write.ts";

let root = "";

const GOOD_SKILL = (name: string, description = "Use when the task needs it") =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nRules with why.\n`;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-utils-skills-"));
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("frontmatter parser (US-004)", () => {
	test("parses a well-formed SKILL.md", () => {
		const parsed = parseSkillFile(GOOD_SKILL("my-skill"));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.frontmatter.name).toBe("my-skill");
			expect(parsed.body).toContain("Rules with why.");
		}
	});

	test("rejections name the fix", () => {
		const cases: Array<[string, RegExp]> = [
			["", /empty/],
			["no frontmatter here", /---/],
			["---\nname: x\n", /not closed/],
			["---\nname: x\n---\n\n", /body is empty/],
		];
		for (const [content, matches] of cases) {
			const parsed = parseSkillFile(content);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toMatch(matches);
		}
		const broken = parseSkillFile("---\nname: [unclosed\n---\n\nbody\n");
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error).toMatch(/YAML does not parse/);
		const scalar = parseSkillFile("---\njust a string\n---\n\nbody\n");
		expect(scalar.ok).toBe(false);
		if (!scalar.ok) expect(scalar.error).toMatch(/mapping/);
	});

	test("lenient parse returns null on garbage (index flags, not crashes)", () => {
		expect(parseFrontmatterLenient("garbage")).toBeNull();
		expect(parseFrontmatterLenient(GOOD_SKILL("ok"))?.name).toBe("ok");
	});

	test("validateCreate: hard errors vs advisory warning", () => {
		const bad = validateCreate(GOOD_SKILL("Bad Name"));
		expect(bad.errors).toHaveLength(1);
		expect(bad.errors[0]).toMatch(/\^\[a-z0-9\]/);
		expect(bad.errors[0]).toMatch(/≤64 chars|≤64/);

		const long = validateCreate(
			GOOD_SKILL("long-desc", `Use when ${"x".repeat(70)}`),
		);
		expect(long.errors).toHaveLength(0);
		expect(long.warnings).toHaveLength(1);
		expect(long.warnings[0]).toMatch(/advisory|chars/);

		const missingDesc = validateCreate("---\nname: ok\n---\n\nbody\n");
		expect(missingDesc.errors[0]).toMatch(/description/);

		const category = validateCreate(GOOD_SKILL("ok"), "../escape");
		expect(category.errors[0]).toMatch(/category/);

		const recommended = validateCreate(GOOD_SKILL("ok"));
		expect(recommended.errors).toHaveLength(0);
	});
});

describe("write ops (snapshot → write → verify)", () => {
	test("create writes the file and reports warnings; exists → error naming patch", () => {
		const result = createSkill(
			{
				skillsRoot: root,
				name: "alpha",
				category: "cat-a",
				newCategory: true,
			},
			GOOD_SKILL("alpha", `Use when ${"y".repeat(70)}`),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return; // narrowing
		const path = join(root, "cat-a", "alpha", SKILL_MD);
		expect(readFileSync(path, "utf8")).toContain("name: alpha");
		expect(result.warnings).toHaveLength(1); // long-desc advisory

		const dup = createSkill(
			{ skillsRoot: root, name: "alpha", category: "cat-a" },
			GOOD_SKILL("alpha"),
		);
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.error).toMatch(/action:"patch"/);
	});

	test("create honours category and rejects traversal-ish names", () => {
		const nested = createSkill(
			{
				skillsRoot: root,
				name: "beta",
				category: "writing",
				newCategory: true,
			},
			GOOD_SKILL("beta"),
		);
		expect(nested.ok).toBe(true);
		if (nested.ok)
			expect(nested.path).toBe(join(root, "writing", "beta", SKILL_MD));

		expect(validateTargetish("a/b")).toMatch(/invalid/);
	});

	test("patch: exact, fuzzy fallback, multi-match without replace_all", () => {
		const path = join(root, "cat-a", "alpha", SKILL_MD);
		const exact = patchSkill(
			path,
			"Rules with why.",
			"Rules with why, updated.",
		);
		expect(exact.ok).toBe(true);
		if (!exact.ok) return; // narrowing
		expect(readFileSync(path, "utf8")).toContain("updated.");

		// Trailing whitespace + smart apostrophe → fuzzy path matches
		// (normalizeForFuzzyMatch: trimEnd + Unicode quotes → ASCII).
		const fuzzy = patchSkill(
			path,
			"Rules with why, updated. \n",
			"Rules: why!",
		);
		expect(fuzzy.ok).toBe(true);
		if (!fuzzy.ok) return; // narrowing
		expect(fuzzy.warnings[0]).toMatch(/fuzzy/);

		const content = readFileSync(path, "utf8");
		writeFileSync(
			path,
			`${content}\nWhy: repeated marker\nWhy: repeated marker\n`,
		);
		const multi = patchSkill(path, "Why: repeated marker", "Why: marker");
		expect(multi.ok).toBe(false);
		if (!multi.ok) expect(multi.error).toMatch(/replace_all/);
		const all = patchSkill(path, "Why: repeated marker", "Why: marker", true);
		expect(all.ok).toBe(true);
		expect(readFileSync(path, "utf8").match(/marker/g)?.length).toBe(2);
	});

	test("patch: missing old_string → fixable error, file untouched", () => {
		const path = join(root, "cat-a", "alpha", SKILL_MD);
		const before = readFileSync(path, "utf8");
		const miss = patchSkill(path, "not in the file at all", "x");
		expect(miss.ok).toBe(false);
		if (!miss.ok) expect(miss.error).toMatch(/not found/);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("delete removes the dir; failed delete rolls files back", () => {
		const dir = skillDir({ skillsRoot: root, name: "with-refs" });
		mkdirSync(join(dir, "refs"), { recursive: true });
		const skillMd = join(dir, SKILL_MD);
		writeFileSync(skillMd, GOOD_SKILL("with-refs"));
		writeFileSync(join(dir, "refs", "x.md"), "reference");

		const deleted = deleteSkill(dir);
		expect(deleted.ok).toBe(true);
		expect(
			(() => {
				try {
					readFileSync(skillMd, "utf8");
					return true;
				} catch {
					return false;
				}
			})(),
		).toBe(false);
		expect(() => readFileSync(skillMd, "utf8")).toThrow();

		// Failed delete → snapshot restore. refs dir made unlinkable.
		mkdirSync(join(dir, "refs"), { recursive: true });
		writeFileSync(skillMd, GOOD_SKILL("with-refs"));
		writeFileSync(join(dir, "refs", "x.md"), "reference");
		chmodSync(join(dir, "refs"), 0o555);
		const failed = deleteSkill(dir);
		expect(failed.ok).toBe(false);
		chmodSync(join(dir, "refs"), 0o755); // restore perms before asserts on disk state
		expect(readFileSync(skillMd, "utf8")).toContain("name: with-refs");
	});
});

describe("skill organization (US-005): categories, locate-by-name, move", () => {
	const roots: string[] = [];
	function freshRoot(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-utils-org-"));
		roots.push(dir);
		return dir;
	}
	function seed(skillsRoot: string, name: string, category?: string): string {
		const dir = join(skillsRoot, ...(category ? [category] : []), name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, SKILL_MD), GOOD_SKILL(name));
		return dir;
	}
	afterAll(() => {
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	});

	test("create: category required; list is one line with counts; new_category creates", () => {
		const skillsRoot = freshRoot();
		seed(skillsRoot, "a1", "testing");
		seed(skillsRoot, "a2", "testing");
		seed(skillsRoot, "b1", "git-release");
		seed(skillsRoot, "legacy"); // root-level skill is not a category

		expect(listCategories(skillsRoot)).toEqual([
			{ name: "git-release", count: 1 },
			{ name: "testing", count: 2 },
		]);
		const content = GOOD_SKILL("fresh");

		const missing = createSkill({ skillsRoot, name: "fresh" }, content);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error).not.toContain("\n");
			expect(missing.error).toContain("categories: git-release(1) testing(2)");
		}

		const unknown = createSkill(
			{ skillsRoot, name: "fresh", category: "typo" },
			content,
		);
		expect(unknown.ok).toBe(false);
		expect(listCategories(skillsRoot).map((c) => c.name)).not.toContain("typo");

		const skillAsCategory = createSkill(
			{ skillsRoot, name: "fresh", category: "legacy", newCategory: true },
			content,
		);
		expect(skillAsCategory.ok).toBe(false);

		expect(
			createSkill({ skillsRoot, name: "fresh", category: "testing" }, content)
				.ok,
		).toBe(true);
		const created = createSkill(
			{ skillsRoot, name: "other", category: "novel", newCategory: true },
			GOOD_SKILL("other"),
		);
		expect(created.ok).toBe(true);
		expect(listCategories(skillsRoot).map((c) => c.name)).toContain("novel");

		// Names are unique across categories (locate-by-name depends on it).
		const dup = createSkill(
			{ skillsRoot, name: "fresh", category: "git-release" },
			content,
		);
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.error).toMatch(/testing\/fresh/);
	});

	test("locate: by name in any category or root; ambiguous and contradicting category error", () => {
		const skillsRoot = freshRoot();
		seed(skillsRoot, "solo", "testing");
		seed(skillsRoot, "old"); // legacy root-level
		seed(skillsRoot, "twin", "testing");
		seed(skillsRoot, "twin", "ops"); // only reachable by hand-made layouts

		const solo = locateSkill(skillsRoot, "solo");
		expect(solo.ok && solo.category).toBe("testing");
		expect(locateSkill(skillsRoot, "solo", "testing").ok).toBe(true);
		const old = locateSkill(skillsRoot, "old");
		expect(old.ok && old.category).toBeUndefined();

		const contradict = locateSkill(skillsRoot, "solo", "ops");
		expect(contradict.ok).toBe(false);
		if (!contradict.ok) expect(contradict.error).toContain("testing/solo");

		const ambiguous = locateSkill(skillsRoot, "twin");
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) {
			expect(ambiguous.error).toContain(join("ops", "twin"));
			expect(ambiguous.error).toContain(join("testing", "twin"));
		}
		const picked = locateSkill(skillsRoot, "twin", "ops");
		expect(picked.ok && picked.category).toBe("ops");

		expect(locateSkill(skillsRoot, "nope").ok).toBe(false);
	});

	test("move: whole dir lands in the category; same category / occupied target refused", () => {
		const skillsRoot = freshRoot();
		const dir = seed(skillsRoot, "mover"); // legacy root skill
		mkdirSync(join(dir, "refs"));
		writeFileSync(join(dir, "refs", "x.md"), "reference");
		seed(skillsRoot, "taken", "ops");

		const from = locateSkill(skillsRoot, "mover");
		if (!from.ok) throw new Error(from.error);
		expect(
			moveSkill(from, { skillsRoot, name: "mover", category: "fresh-cat" }).ok,
		).toBe(false); // new category needs the flag
		const moved = moveSkill(from, {
			skillsRoot,
			name: "mover",
			category: "fresh-cat",
			newCategory: true,
		});
		expect(moved.ok && moved.path).toBe(
			join(skillsRoot, "fresh-cat", "mover", SKILL_MD),
		);
		expect(() => readFileSync(join(dir, SKILL_MD))).toThrow();
		expect(
			readFileSync(
				join(skillsRoot, "fresh-cat", "mover", "refs", "x.md"),
				"utf8",
			),
		).toBe("reference");

		const again = locateSkill(skillsRoot, "mover");
		if (!again.ok) throw new Error(again.error);
		expect(
			moveSkill(again, { skillsRoot, name: "mover", category: "fresh-cat" }).ok,
		).toBe(false);
		// A hand-made occupied target dir is never overwritten.
		mkdirSync(join(skillsRoot, "ops", "mover"));
		expect(
			moveSkill(again, { skillsRoot, name: "mover", category: "ops" }).ok,
		).toBe(false);
	});

	test("move: failure rolls back — skill intact, no stray new category", () => {
		const skillsRoot = freshRoot();
		const dir = seed(skillsRoot, "stuck", "src");
		const from = locateSkill(skillsRoot, "stuck");
		if (!from.ok) throw new Error(from.error);
		chmodSync(join(skillsRoot, "src"), 0o555); // cannot rename out of it
		const result = moveSkill(from, {
			skillsRoot,
			name: "stuck",
			category: "dest",
			newCategory: true,
		});
		chmodSync(join(skillsRoot, "src"), 0o755);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.rolledBack).toBe(true);
		expect(readFileSync(join(dir, SKILL_MD), "utf8")).toContain("name: stuck");
		expect(listCategories(skillsRoot).map((c) => c.name)).toEqual(["src"]);
	});
});

describe("read-before-write guard data (seen-map + path resolve)", () => {
	test("seen-map marks/dedupes; resolveSkillMdPath scopes to the root", () => {
		const seen = createSeenMap();
		const skillMd = join(root, "cat-a", "alpha", SKILL_MD);
		expect(seen.has(skillMd)).toBe(false);
		seen.mark(skillMd);
		seen.mark(skillMd);
		expect(seen.has(skillMd)).toBe(true);
		expect(seen.paths()).toHaveLength(1);

		expect(resolveSkillMdPath(skillMd, root, "/somewhere")).toBe(skillMd);
		expect(resolveSkillMdPath("cat-a/alpha/SKILL.md", root, root)).toBe(
			skillMd,
		);
		expect(resolveSkillMdPath("/elsewhere/SKILL.md", root, root)).toBeNull();
		expect(
			resolveSkillMdPath(join(root, "cat-a", "alpha", "other.md"), root, root),
		).toBeNull();
		expect(
			resolveSkillMdPath(join(root, "..", "evil", "SKILL.md"), root, root),
		).toBeNull();
		// Same spellings pi's read() accepts must mark the same resolved key.
		expect(resolveSkillMdPath(`@${skillMd}`, root, "/x")).toBe(skillMd);
		expect(
			resolveSkillMdPath(`${root}/./cat-a/alpha//${SKILL_MD}`, root, "/x"),
		).toBe(skillMd);
		expect(
			resolveSkillMdPath(
				`~/${relative(dirname(root), skillMd)}`,
				root,
				"/x",
				dirname(root),
			),
		).toBe(skillMd);
	});

	test("requires checker caches PATH hits/misses", () => {
		const check = createRequiresChecker({ PATH: "/bin" });
		expect(check("sh")).toBe(true); // /bin/sh exists on macOS/Linux CI
		expect(check("bogus-bin-us004")).toBe(false);
		expect(check("bogus-bin-us004")).toBe(false); // cached
	});
});

describe("nudge tracker (spec 499573a: fire once at threshold, reset)", () => {
	test("interval 0 = off", () => {
		const t = createNudgeTracker(0);
		for (let i = 0; i < 50; i++) t.onToolCall(false);
		expect(t.onToolResult(false)).toBeNull();
	});

	test("fires once at the threshold, then counts again", () => {
		const t = createNudgeTracker(3);
		t.onToolCall(false);
		t.onToolCall(false);
		expect(t.onToolResult(false)).toBeNull();
		t.onToolCall(false);
		const line = t.onToolResult(false);
		expect(line).toMatch(/\[skills\] 3 iters since last skill write/);
		expect(t.onToolResult(false)).toBeNull(); // no spam
		t.onToolCall(false);
		t.onToolCall(false);
		t.onToolCall(false);
		expect(t.onToolResult(false)).toMatch(/3 iters/);
	});

	test("any skill_write call resets; error results never fire", () => {
		const t = createNudgeTracker(2);
		t.onToolCall(false);
		t.onToolCall(false);
		expect(t.onToolResult(true)).toBeNull(); // error result: no graft
		t.onToolCall(false);
		t.onToolCall(false);
		t.onToolCall(true); // skill_write call resets
		expect(t.onToolResult(false)).toBeNull();
		t.onToolCall(false);
		t.onToolCall(false);
		expect(t.onToolResult(false)).toMatch(/2 iters/);
	});
});

describe("settings.skills", () => {
	test("defaults: smart / core 15 / hint on / nudge 10; 0 and native accepted; invalid warned", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-utils-skills-settings-"));
		try {
			const defaults = loadSettings(dir).settings.skills;
			expect(defaults).toEqual({
				index: "smart",
				coreLimit: 15,
				hint: true,
				nudgeInterval: 10,
			});

			writeFileSync(
				join(dir, "pi-utils.json"),
				JSON.stringify({ skills: { index: "native", nudgeInterval: 0 } }),
			);
			const custom = loadSettings(dir);
			expect(custom.warnings).toEqual([]);
			expect(custom.settings.skills).toEqual({
				index: "native",
				coreLimit: 15,
				hint: true,
				nudgeInterval: 0,
			});

			writeFileSync(
				join(dir, "pi-utils.json"),
				JSON.stringify({ skills: { index: "bogus", nudgeInterval: -1 } }),
			);
			const invalid = loadSettings(dir);
			expect(invalid.warnings).toHaveLength(2);
			expect(invalid.settings.skills).toEqual({
				index: "smart",
				coreLimit: 15,
				hint: true,
				nudgeInterval: 10,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** validateTarget is exercised through createSkill for path safety. */
function validateTargetish(name: string): string {
	const bad = createSkill(
		{ skillsRoot: root, name, category: "cat-a" },
		GOOD_SKILL("x"),
	);
	return bad.ok ? "" : bad.error;
}
