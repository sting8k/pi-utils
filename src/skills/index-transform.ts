/**
 * US-004 — smart index transform: re-render native's `<available_skills>`
 * block with a visibility pipeline. ONE pass per turn from before_agent_start;
 * the native tag name is kept so the rules block and any tooling keyed on it
 * stay coherent. Parse failure or missing block → null (caller passes the
 * system prompt through unchanged — worst case = native).
 *
 * Data split (spec): WHICH skills exist comes from the native block
 * (name + location per entry — user dir, project dir, extension-contributed,
 * collision handling all inherited untouched); VISIBILITY conditions come
 * from reading each entry's SKILL.md frontmatter off disk (frontmatter-only,
 * cached per session, shared parser). We never rediscover skills ourselves —
 * we only decide how loudly each shows.
 *
 * Pipeline: platforms excludes host → requires missing from PATH →
 * disable-model-invocation → over-limit demotion (names-only) → quality
 * flags → tail pointer.
 *
 * Pure module: fs access injectable for tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { parseFrontmatterLenient } from "./frontmatter.ts";

export interface SkillIndexEntry {
	name: string;
	description: string;
	location: string;
}

export interface SkillMeta {
	platforms?: unknown;
	requires?: unknown;
	disableModelInvocation?: unknown;
	/** Frontmatter failed to parse at all — flagged, not hidden. */
	malformed?: boolean;
}

export interface IndexTransformDeps {
	skillsRoot: string;
	/** All candidate scan roots (user + project + contributed) for grouping. */
	knownRoots: string[];
	/** Host platform (process.platform at the call site). */
	hostPlatform: string;
	/** Binary-on-PATH check (session-cached by the caller). */
	requiresCheck: (bin: string) => boolean;
	/** Frontmatter cache keyed by SKILL.md path — caller persists per session. */
	metaCache: Map<string, SkillMeta | null>;
	/** Injectable fs for tests. Defaults to node fs. */
	readSkillFile?: (path: string) => string | null;
}

export interface IndexTransformResult {
	/** The re-emitted `<available_skills>…</available_skills>` block. */
	block: string;
	/** Offset of the original block in the system prompt (for splicing). */
	start: number;
	end: number;
	hidden: string[];
	demoted: string[];
	flagged: string[];
}

export function transformSkillsIndex(
	systemPrompt: string,
	fullLimit: number,
	recentlyUsed: string[],
	deps: IndexTransformDeps,
): IndexTransformResult | null {
	const blockMatch = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(
		systemPrompt,
	);
	if (!blockMatch) return null;

	const entryRe =
		/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
	const entries: SkillIndexEntry[] = [];
	for (const m of systemPrompt
		.slice(blockMatch.index, blockMatch.index + blockMatch[0].length)
		.matchAll(entryRe)) {
		entries.push({
			name: unescapeXml(m[1] ?? "").trim(),
			description: unescapeXml(m[2] ?? "").trim(),
			location: unescapeXml(m[3] ?? "").trim(),
		});
	}
	// Zero entries parsed → we don't understand the native format anymore.
	if (entries.length === 0) return null;

	const recent = new Set(recentlyUsed);

	// Step 1–3: visibility hides.
	const visible: Array<{ entry: SkillIndexEntry; meta: SkillMeta | null }> = [];
	const hidden: string[] = [];
	const hostNames = hostPlatformNames(deps.hostPlatform);
	for (const entry of entries) {
		const meta = metaFor(entry.location, deps);
		const platforms = stringArray(meta?.platforms);
		if (platforms.length > 0 && !platforms.some((p) => hostNames.includes(p))) {
			hidden.push(entry.name);
			continue;
		}
		const requires = stringArray(meta?.requires);
		if (requires.some((bin) => !deps.requiresCheck(bin))) {
			hidden.push(entry.name);
			continue;
		}
		if (meta?.disableModelInvocation === true) {
			// Native already filters these from the block; hide again if one
			// ever slips through (belt-and-suspenders — cheap).
			hidden.push(entry.name);
			continue;
		}
		visible.push({ entry, meta });
	}

	// Step 4: over-limit demotion — categories without a recently-used skill
	// collapse to names-only.
	let demotedCategories: string[] = [];
	if (visible.length > fullLimit) {
		const categories = new Map<string, boolean>(); // category → hasRecent
		for (const { entry } of visible) {
			const category = categoryOf(entry.location, deps.skillsRoot);
			const has = categories.get(category) === true;
			categories.set(category, has || recent.has(entry.location));
		}
		demotedCategories = [...categories.keys()].filter(
			(category) => !categories.get(category),
		);
	}

	// Step 5: quality flags — missing description (native renders only when
	// present, so this is near-dead but cheap), malformed frontmatter, and
	// near-identical desc prefixes within one category.
	const overlapGroups = new Map<string, SkillIndexEntry[]>();
	for (const { entry } of visible) {
		const category = categoryOf(entry.location, deps.skillsRoot);
		const key = `${category}::${normalizeDesc(entry.description).slice(0, 60)}`;
		const group = overlapGroups.get(key);
		if (group) group.push(entry);
		else overlapGroups.set(key, [entry]);
	}
	const overlapByName = new Map<string, string[]>();
	for (const group of overlapGroups.values()) {
		if (group.length < 2) continue;
		for (const entry of group) {
			const others = group.filter((e) => e !== entry).map((e) => e.name);
			overlapByName.set(entry.name, others);
		}
	}

	const flagged: string[] = [];
	const shownFull: Array<{ entry: SkillIndexEntry; suffix: string }> = [];
	for (const { entry, meta } of visible) {
		if (
			demotedCategories.includes(categoryOf(entry.location, deps.skillsRoot))
		) {
			continue;
		}
		const flags: string[] = [];
		if (meta === null || meta.malformed === true) {
			flags.push("⚠ malformed frontmatter");
			flagged.push(entry.name);
		}
		if (entry.description.trim().length === 0) {
			flags.push("⚠ missing description");
			flagged.push(entry.name);
		}
		const others = overlapByName.get(entry.name);
		if (others) {
			flags.push(`⚠ possible overlap ${others.join("/")}≈${entry.name}`);
			flagged.push(entry.name);
		}
		shownFull.push({
			entry,
			suffix: flags.length > 0 ? ` ${flags.join(" ")}` : "",
		});
	}

	// Emit (spec e9150d8): entries grouped by root dir — one `# <abs root>`
	// header per group, entries carry only name + inline description.
	// `location=` appears ONLY when the same name exists under two different
	// roots (native collision case — the attr then disambiguates). Repeating
	// a 40-char root prefix on every entry is pure prompt waste.
	const rootsByName = new Map<string, Set<string>>();
	for (const { entry } of shownFull) {
		const root = rootOf(entry.location, deps.knownRoots);
		const roots = rootsByName.get(entry.name);
		if (roots) roots.add(root);
		else rootsByName.set(entry.name, new Set([root]));
	}

	const lines: string[] = ["<available_skills>"];
	let currentRoot: string | null = null;
	for (const { entry, suffix } of shownFull) {
		const root = rootOf(entry.location, deps.knownRoots);
		if (root !== currentRoot) {
			lines.push(`# ${escapeXml(root)}`);
			currentRoot = root;
		}
		const collision = (rootsByName.get(entry.name)?.size ?? 0) > 1;
		const locationAttr = collision
			? ` location="${escapeXml(entry.location)}"`
			: "";
		lines.push(
			`  <skill name="${escapeXml(entry.name)}"${locationAttr}>${escapeXml(entry.description)}${suffix}</skill>`,
		);
	}

	// Demoted categories: names-only, one line per category.
	const demoted: string[] = [];
	for (const category of demotedCategories) {
		const names = visible
			.filter(
				({ entry }) => categoryOf(entry.location, deps.skillsRoot) === category,
			)
			.map(({ entry }) => entry.name);
		demoted.push(...names);
		lines.push(
			`  <collapsed category="${escapeXml(category)}">${escapeXml(names.join(", "))}</collapsed>`,
		);
	}

	// Step 6: tail pointer when anything was hidden or demoted.
	const notFullyShown = hidden.length + demoted.length;
	if (notFullyShown > 0) {
		lines.push(
			`  ${notFullyShown} more — ls ${deps.skillsRoot} or /skill:<name>`,
		);
	}
	lines.push("</available_skills>");

	return {
		block: lines.join("\n"),
		start: blockMatch.index,
		end: blockMatch.index + blockMatch[0].length,
		hidden,
		demoted,
		flagged,
	};
}

/** Frontmatter meta for an entry, cached per session. null = unreadable/malformed. */
function metaFor(location: string, deps: IndexTransformDeps): SkillMeta | null {
	const cached = deps.metaCache.get(location);
	if (cached !== undefined) return cached;
	const meta = readMeta(location, deps);
	deps.metaCache.set(location, meta);
	return meta;
}

function readMeta(
	location: string,
	deps: IndexTransformDeps,
): SkillMeta | null {
	const read = deps.readSkillFile ?? defaultRead;
	const content = read(location);
	if (content === null) return null;
	const fm = parseFrontmatterLenient(content);
	if (fm === null) return { malformed: true };
	return {
		platforms: fm.platforms,
		requires: fm.requires,
		disableModelInvocation: fm["disable-model-invocation"],
	};
}

function defaultRead(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function stringArray(value: unknown): string[] {
	// YAML scalar shorthand ("platforms: linux") normalizes to [value] —
	// silently dropping it would no-op the filter (field-reported bug).
	if (typeof value === "string") return value ? [value] : [];
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

function hostPlatformNames(platform: string): string[] {
	switch (platform) {
		case "darwin":
			return ["darwin", "macos", "mac", "osx"];
		case "win32":
			return ["win32", "windows", "win"];
		default:
			return [platform];
	}
}

/**
 * Root dir of a skill (for group headers): a known scan root containing the
 * location, else the nearest ancestor named "skills", else the skill dir's
 * parent (best effort for extension-contributed dirs).
 */
export function rootOf(location: string, knownRoots: string[]): string {
	for (const root of knownRoots) {
		if (location === root || location.startsWith(`${root}/`)) return root;
	}
	let dir = dirname(dirname(location));
	for (;;) {
		if (basename(dir) === "skills") return dir;
		const parent = dirname(dir);
		if (parent === dir) return dirname(dirname(location));
		dir = parent;
	}
}

/**
 * Category = the skill dir's PARENT relative to the skills root (native
 * layout: <skillsRoot>/<category>/<name>/SKILL.md; root-level skills group
 * under "general", external locations under "other").
 */
export function categoryOf(location: string, skillsRoot: string): string {
	const rel = relative(skillsRoot, dirname(dirname(location)));
	if (rel.startsWith("..") || rel.length === 0)
		return rel.startsWith("..") ? "other" : "general";
	return rel;
}

function normalizeDesc(desc: string): string {
	return desc.toLowerCase().replace(/\s+/g, " ").trim();
}

// Native's escapeXml — same mapping, so our re-emit is drop-in parseable by
// anything that understands the native block.
export function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function unescapeXml(str: string): string {
	return str
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}
