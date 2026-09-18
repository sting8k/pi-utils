import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { parseSkillFile } from "../src/skills/frontmatter.ts";
import {
	categoryOf,
	transformSkillsIndex,
} from "../src/skills/index-transform.ts";

let root = "";
let metaCache: Map<string, ReturnType<typeof Object>>;

/** Native-format <available_skills> block, as pi 0.85.1 renders it. */
function nativeBlock(
	entries: Array<[name: string, description: string, location: string]>,
): string {
	const lines = ["<available_skills>"];
	for (const [name, description, location] of entries) {
		lines.push("  <skill>");
		lines.push(`    <name>${name}</name>`);
		lines.push(`    <description>${description}</description>`);
		lines.push(`    <location>${location}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function skill(
	name: string,
	frontmatter: Record<string, unknown>,
	category?: string,
	blockDesc?: string,
): [string, string, string] {
	const dir = join(root, ...(category ? [category] : []), name);
	mkdirSync(dir, { recursive: true });
	const fm = Object.entries(frontmatter)
		.map(([k, v]) =>
			Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${String(v)}`,
		)
		.join("\n");
	const content = `---\n${fm}\n---\n\nbody\n`;
	writeFileSync(join(dir, "SKILL.md"), content);
	return [name, blockDesc ?? `desc of ${name}`, join(dir, "SKILL.md")];
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-utils-skills-index-"));
	metaCache = new Map();
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function transform(
	entries: Array<[string, string, string]>,
	opts: {
		hostPlatform?: string;
		fullLimit?: number;
		recentlyUsed?: string[];
		requires?: (bin: string) => boolean;
		cwd?: string;
	} = {},
) {
	const prompt = `preamble\n${nativeBlock(entries)}\nepilogue`;
	return {
		prompt,
		result: transformSkillsIndex(
			prompt,
			opts.fullLimit ?? 50,
			opts.recentlyUsed ?? [],
			{
				skillsRoot: root,
				knownRoots: [root],
				cwd: opts.cwd ?? "/home/proj",
				hostPlatform: opts.hostPlatform ?? "darwin",
				requiresCheck: opts.requires ?? (() => true),
				metaCache,
			},
		),
	};
}

describe("smart index transform (US-004)", () => {
	test("keeps the native tag name; groups by root; location only on collision", () => {
		const entries = [
			skill("alpha", { name: "alpha", description: "desc of alpha" }),
		];
		const { prompt, result } = transform(entries);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.block.startsWith("<available_skills>")).toBe(true);
		// Group header carries the abs root ONCE; the entry is name+desc only —
		// no location attr without a collision.
		expect(result.block).toContain(`# ${root}`);
		expect(result.block).toContain('<skill name="alpha">desc of alpha</skill>');
		expect(result.block).not.toContain("location=");

		// Collision: same name under a different known root → both entries
		// carry location=.
		const otherRoot = normalize(join(root, "..", "other-skills-root"));
		mkdirSync(join(otherRoot, "alpha"), { recursive: true });
		const alphaLocation = join(otherRoot, "alpha", "SKILL.md");
		writeFileSync(
			alphaLocation,
			"---\nname: alpha\ndescription: project twin\n---\n\nbody\n",
		);
		const collided = transform([
			...entries,
			["alpha", "project twin", alphaLocation],
		]);
		expect(collided.result).not.toBeNull();
		if (!collided.result) return;
		expect(collided.result.block).toContain(`# ${root}`);
		expect(collided.result.block).toContain(`# ${otherRoot}`);
		const locationLines = collided.result.block
			.split("\n")
			.filter((line) => line.includes("location="));
		expect(locationLines).toHaveLength(2);
		expect(collided.result.block).toContain(`location="${alphaLocation}"`);

		// Spliced back into the prompt: native header/epilogue survive.
		const spliced =
			prompt.slice(0, result.start) + result.block + prompt.slice(result.end);
		expect(spliced).toContain("preamble");
		expect(spliced).toContain("desc of alpha");
	});

	test("scalar platforms/requires (YAML shorthand) normalize and filter", () => {
		const entries = [
			skill("win-scalar", {
				name: "win-scalar",
				description: "d",
				platforms: "windows", // scalar, not array
			}),
			skill("missing-bin-scalar", {
				name: "missing-bin-scalar",
				description: "d",
				requires: "bogus-bin-xyz", // scalar, not array
			}),
			skill("host-scalar", {
				name: "host-scalar",
				description: "d",
				platforms: "macos", // scalar on host — visible
			}),
		];
		const { result } = transform(entries, { requires: () => false });
		if (!result) return expect(result).not.toBeNull();
		expect(result.hidden).toEqual(["win-scalar", "missing-bin-scalar"]);
		expect(result.block).toContain('"host-scalar"');
	});

	test("platforms: windows-only skill hidden on darwin", () => {
		const entries = [
			skill("win-only", {
				name: "win-only",
				description: "d",
				platforms: ["windows"],
			}),
			skill("mac-ok", {
				name: "mac-ok",
				description: "d",
				platforms: ["windows", "macos"],
			}),
		];
		const { result } = transform(entries);
		if (!result) return expect(result).not.toBeNull();
		expect(result.hidden).toEqual(["win-only"]);
		expect(result.block).toContain('"mac-ok"');
		expect(result.block).not.toContain('"win-only"');
		expect(result.block).toMatch(
			/\n\n# not shown in full\n {2}1 hidden by platforms\/requires\/dirs — ls .+ or \/skill:<name>\n<\/available_skills>$/,
		);
	});

	test("requires: missing binary hides", () => {
		const entries = [
			skill("needs-tool", {
				name: "needs-tool",
				description: "d",
				requires: ["bogus-bin-us004"],
			}),
		];
		const { result } = transform(entries, {
			requires: (bin) => bin !== "bogus-bin-us004",
		});
		if (!result) return expect(result).not.toBeNull();
		expect(result.hidden).toEqual(["needs-tool"]);
	});

	test("dirs: exact cwd-segment scoping, scalar normalize, no substring", () => {
		const entries = [
			skill("pinned", {
				name: "pinned",
				description: "d",
				dirs: ["pi-utilities"],
			}),
			skill("family", {
				name: "family",
				description: "d",
				dirs: ["pi-agent-ext"],
			}),
			skill("elsewhere", {
				name: "elsewhere",
				description: "d",
				dirs: "other-repo", // scalar shorthand
			}),
			skill("noscoped", { name: "noscoped", description: "d" }),
			skill("substr", { name: "substr", description: "d", dirs: ["pi-util"] }),
		];
		const { result } = transform(entries, {
			cwd: "/a/pi-agent-ext/pi-utilities",
		});
		if (!result) return expect(result).not.toBeNull();
		expect(result.hidden).toEqual(["elsewhere", "substr"]);
		expect(result.block).toContain('"pinned"'); // one-segment repo pinned
		expect(result.block).toContain('"family"'); // ancestor segment
		expect(result.block).toContain('"noscoped"'); // absent key → shown
		expect(result.block).not.toContain('"elsewhere"');
		expect(result.block).not.toContain('"substr"'); // no substring match
		expect(result.block).toMatch(
			/2 hidden by platforms\/requires\/dirs — ls .+/,
		);
	});

	test("disable-model-invocation hidden (belt-and-suspenders)", () => {
		const entries = [
			skill("slash-only", {
				name: "slash-only",
				description: "d",
				"disable-model-invocation": true,
			}),
		];
		const { result } = transform(entries);
		if (!result) return expect(result).not.toBeNull();
		expect(result.hidden).toEqual(["slash-only"]);
	});

	test("over-limit: categories without recently-used collapse to names-only", () => {
		const entries = [
			skill("c1-a", { name: "c1-a", description: "d" }, "cat1"),
			skill("c1-b", { name: "c1-b", description: "d" }, "cat1"),
			skill("c2-a", { name: "c2-a", description: "d" }, "cat2"),
			skill("c2-b", { name: "c2-b", description: "d" }, "cat2"),
			skill("c2-c", { name: "c2-c", description: "d" }, "cat2"),
		];
		// limit 3: cat2 (3 skills) over, cat1 (2) fits — but cat1 has no recent
		// skill either; total visible 5 > 3 and BOTH categories demote when
		// none recently used. cat2 with a recently-used skill stays full.
		const { result } = transform(entries, {
			fullLimit: 3,
			recentlyUsed: [join(root, "cat2", "c2-a", "SKILL.md")],
		});
		if (!result) return expect(result).not.toBeNull();
		expect(result.block).toMatch(
			/\n\n# not shown in full\n {2}<collapsed category="cat1">c1-a, c1-b<\/collapsed>\n<\/available_skills>$/,
		); // own section; no "hidden" pointer when nothing was hidden
		expect(result.block).toContain('"c2-a"'); // full entry kept
		expect(result.demoted).toEqual(["c1-a", "c1-b"]);
	});

	test("quality flags: malformed frontmatter and desc overlap", () => {
		const dupDir = join(root, "dup");
		mkdirSync(dupDir, { recursive: true });
		writeFileSync(join(dupDir, "SKILL.md"), "---\nname: [broken\n---\n\nx\n");
		const entries: Array<[string, string, string]> = [
			["dup", "use when deploying the service", join(dupDir, "SKILL.md")],
			skill(
				"dup2",
				{ name: "dup2", description: "use when deploying the service" },
				undefined,
				"use when deploying the service",
			),
			skill("clean", { name: "clean", description: "unrelated description" }),
		];
		const { result } = transform(entries);
		if (!result) return expect(result).not.toBeNull();
		expect(result.flagged).toContain("dup");
		expect(result.flagged).toContain("dup2");
		expect(result.block).toMatch(/⚠ malformed frontmatter/);
		expect(result.block).toMatch(
			/⚠ possible overlap dup2≈dup|⚠ possible overlap dup≈dup2/,
		);
	});

	test("unparseable / missing native block → passthrough (null)", () => {
		expect(
			transformSkillsIndex("no block at all", 50, [], {
				skillsRoot: root,
				knownRoots: [root],
				cwd: "/home/proj",
				hostPlatform: "darwin",
				requiresCheck: () => true,
				metaCache,
			}),
		).toBeNull();
		const broken =
			"pre\n<available_skills>\n  totally not xml\n</available_skills>\npost";
		expect(
			transformSkillsIndex(broken, 50, [], {
				skillsRoot: root,
				knownRoots: [root],
				cwd: "/home/proj",
				hostPlatform: "darwin",
				requiresCheck: () => true,
				metaCache,
			}),
		).toBeNull();
	});

	test("categoryOf: skill-dir parent relative to root; general/other fallbacks", () => {
		expect(categoryOf(join(root, "cat", "x", "SKILL.md"), root)).toBe("cat");
		expect(categoryOf(join(root, "name", "SKILL.md"), root)).toBe("general");
		expect(categoryOf("/outside/anywhere/SKILL.md", root)).toBe("other");
	});

	test("parsed metadata actually comes from the shared parser", () => {
		skill("meta", { name: "meta", description: "d", platforms: ["linux"] });
		const parsed = parseSkillFile(
			`---\nname: meta\ndescription: d\nplatforms: [linux]\n---\n\nbody\n`,
		);
		expect(parsed.ok).toBe(true);
	});
});
