import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { parseSkillFile } from "../src/skills/frontmatter.ts";
import {
	categoryOf,
	replaceSkillsBlock,
	transformSkillsIndex,
	truncateDesc,
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
		coreLimit?: number;
		usage?: Record<string, number>;
		requires?: (bin: string) => boolean;
		cwd?: string;
		fullMax?: number;
	} = {},
) {
	const prompt = `preamble\n${nativeBlock(entries)}\nepilogue`;
	return {
		prompt,
		result: transformSkillsIndex(prompt, {
			skillsRoot: root,
			knownRoots: [root],
			cwd: opts.cwd ?? "/home/proj",
			hostPlatform: opts.hostPlatform ?? "darwin",
			requiresCheck: opts.requires ?? (() => true),
			metaCache,
			coreLimit: opts.coreLimit ?? 15,
			usage: new Map(Object.entries(opts.usage ?? {})),
			// Default 0: these tests pin the compact (large-set) layout.
			fullCatalogMaxChars: opts.fullMax ?? 0,
		}),
	};
}

describe("tier-1 catalog (US-004/US-005)", () => {
	test("keeps the native tag name; root skills → categories; location only on collision", () => {
		const entries = [
			skill("alpha", { name: "alpha", description: "desc of alpha" }),
		];
		const { prompt, result } = transform(entries);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.block.startsWith("<available_skills>")).toBe(true);
		// Names only; the root appears once, in the categories header.
		expect(result.block).toContain(
			'<category name="uncategorized">alpha</category>',
		);
		expect(result.block).not.toContain("desc of alpha");
		expect(result.block).not.toContain("location=");

		// Collision: same name under a different root → only the outside-root
		// twin (own `# <root>` group) carries location=.
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
		expect(collided.result.block).toContain(`# ${otherRoot}`);
		expect(collided.result.block).toContain(
			`<skill name="alpha" location="${alphaLocation}">project twin</skill>`,
		);

		// Spliced back into the prompt: native header/epilogue survive.
		const spliced = replaceSkillsBlock(prompt, result.block);
		expect(spliced.startsWith("preamble\n<available_skills>")).toBe(true);
		expect(spliced.endsWith("</available_skills>\nepilogue")).toBe(true);
		expect(spliced).not.toContain("desc of alpha");
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
		expect(result.block).toContain("host-scalar");
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
		expect(result.block).toContain("mac-ok");
		expect(result.block).not.toContain("win-only</category>");
		expect(result.block).toMatch(
			/\n\n# hidden\n {2}1 hidden by platforms\/requires\/dirs — ls .+ or \/skill:<name>\n<\/available_skills>$/,
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
		const names = result.visible.map((v) => v.name);
		expect(names).toContain("pinned"); // one-segment repo pinned
		expect(names).toContain("family"); // ancestor segment
		expect(names).toContain("noscoped"); // absent key → shown
		expect(names).not.toContain("elsewhere");
		expect(names).not.toContain("substr"); // no substring match
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

	test("core: top-N by usage, truncated desc, cold start empty; categories stay names-only", () => {
		const long = `${"word ".repeat(40)}end.`;
		const entries = [
			skill(
				"c1-a",
				{ name: "c1-a", description: "d" },
				"cat1",
				"First sentence. Second sentence.",
			),
			skill("c1-b", { name: "c1-b", description: "d" }, "cat1", long),
			skill("c2-a", { name: "c2-a", description: "d" }, "cat2"),
			skill("c2-b", { name: "c2-b", description: "d" }, "cat2"),
		];
		const used = { "c1-a": 3, "c1-b": 9, "c2-a": 1, ghost: 99 };
		const { result } = transform(entries, { coreLimit: 2, usage: used });
		if (!result) return expect(result).not.toBeNull();
		// Highest usage first; limit respected; unknown names ignored.
		expect(result.core).toEqual(["c1-b", "c1-a"]);
		expect(result.block).toContain(
			'<skill name="c1-a" category="cat1">First sentence.</skill>',
		);
		const b = result.block.match(/name="c1-b"[^>]*>([^<]*)</)?.[1] ?? "";
		expect(b.length).toBeLessThanOrEqual(100);
		expect(b.endsWith("…")).toBe(true);
		// Every skill is still in its category line, names only, sorted.
		expect(result.block).toContain(
			'<category name="cat1">c1-a, c1-b</category>',
		);
		expect(result.block).toContain(
			'<category name="cat2">c2-a, c2-b</category>',
		);

		expect(
			transform(entries, { coreLimit: 0, usage: used }).result?.core,
		).toEqual([]);
		expect(transform(entries).result?.block).not.toContain("# core");
		expect(truncateDesc("Short one. More.", 100)).toBe("Short one.");
	});

	test("small set fits the budget → every skill keeps its description; over budget → compact", () => {
		const entries = [
			skill("tiny-a", { name: "tiny-a", description: "Use when a" }, "cat-x"),
			skill("tiny-b", { name: "tiny-b", description: "Use when b" }),
		];
		const full = transform(entries, { fullMax: 10_000 }).result;
		expect(full?.block).toContain('<skill name="tiny-a" category="cat-x">');
		expect(full?.block).toContain('<skill name="tiny-b">'); // uncategorized: no attr
		expect(full?.block).not.toContain("<category ");
		expect(full?.core).toEqual([]);
		const compact = transform(entries, { fullMax: 10 }).result;
		expect(compact?.block).toContain(
			'<category name="cat-x">tiny-a</category>',
		);
		expect(compact?.block).not.toContain("Use when a");
	});

	test("malformed frontmatter is flagged where it costs nothing", () => {
		const dupDir = join(root, "dup");
		mkdirSync(dupDir, { recursive: true });
		writeFileSync(join(dupDir, "SKILL.md"), "---\nname: [broken\n---\n\nx\n");
		const entries: Array<[string, string, string]> = [
			["dup", "use when deploying", join(dupDir, "SKILL.md")],
			skill("clean", { name: "clean", description: "unrelated description" }),
		];
		const { result } = transform(entries);
		if (!result) return expect(result).not.toBeNull();
		expect(result.flagged).toEqual(["dup"]);
		expect(result.block).toContain("clean, dup⚠");
	});

	test("unparseable / missing native block → passthrough (null)", () => {
		expect(
			transformSkillsIndex("no block at all", {
				skillsRoot: root,
				knownRoots: [root],
				cwd: "/home/proj",
				hostPlatform: "darwin",
				requiresCheck: () => true,
				metaCache,
				coreLimit: 15,
				usage: new Map(),
			}),
		).toBeNull();
		const broken =
			"pre\n<available_skills>\n  totally not xml\n</available_skills>\npost";
		expect(
			transformSkillsIndex(broken, {
				skillsRoot: root,
				knownRoots: [root],
				cwd: "/home/proj",
				hostPlatform: "darwin",
				requiresCheck: () => true,
				metaCache,
				coreLimit: 15,
				usage: new Map(),
			}),
		).toBeNull();
	});

	test("categoryOf: skill-dir parent relative to root; uncategorized/other fallbacks", () => {
		expect(categoryOf(join(root, "cat", "x", "SKILL.md"), root)).toBe("cat");
		expect(categoryOf(join(root, "name", "SKILL.md"), root)).toBe(
			"uncategorized",
		);
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
