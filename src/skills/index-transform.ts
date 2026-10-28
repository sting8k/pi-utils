/**
 * US-004/US-005 — tier-1 skills catalog: re-render native's
 * `<available_skills>` block as a SMALL, SESSION-STABLE catalog. The caller
 * computes it once per session and reuses the string verbatim every turn, so
 * the system prompt never changes mid-session (prompt-cache safe). The native
 * tag name is kept so the rules block and any tooling keyed on it stay
 * coherent. Parse failure or missing block → null (caller passes the system
 * prompt through unchanged — worst case = native).
 *
 * Data split (spec): WHICH skills exist comes from the native block
 * (name + location per entry — user dir, project dir, extension-contributed,
 * collision handling all inherited untouched); VISIBILITY conditions come
 * from reading each entry's SKILL.md frontmatter off disk (frontmatter-only,
 * cached per session, shared parser). We never rediscover skills ourselves —
 * we only decide how loudly each shows.
 *
 * Pipeline: platforms excludes host → requires missing from PATH →
 * dirs declares no segment of cwd → disable-model-invocation → emit:
 *   - `core`: the `coreLimit` most-used skills (cross-session usage scores)
 *     with a short description;
 *   - one `<category>` line per category under the skills root, names only;
 *   - skills outside the skills root (project / contributed) keep their
 *     per-root group with short descriptions;
 *   - a pointer line when anything was hidden.
 *
 * Pure module: fs access injectable for tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import {
	DESCRIPTION_SOFT_LIMIT,
	parseFrontmatterLenient,
} from "./frontmatter.ts";

export interface SkillIndexEntry {
	name: string;
	description: string;
	location: string;
}

export interface SkillMeta {
	tags?: unknown;
	platforms?: unknown;
	requires?: unknown;
	dirs?: unknown;
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
	/** Session cwd — dirs visibility matches its path segments exactly. */
	cwd: string;
	/** Binary-on-PATH check (session-cached by the caller). */
	requiresCheck: (bin: string) => boolean;
	/** Frontmatter cache keyed by SKILL.md path — caller persists per session. */
	metaCache: Map<string, SkillMeta | null>;
	/** Max skills in the `core` group (0 = none). */
	coreLimit: number;
	/** Decayed cross-session usage score per skill NAME (see usage.ts). */
	usage: Map<string, number>;
	/** Injectable fs for tests. Defaults to node fs. */
	readSkillFile?: (path: string) => string | null;
	/** Full-catalog budget override (tests). Defaults to FULL_CATALOG_MAX_CHARS. */
	fullCatalogMaxChars?: number;
}

/** A skill that survived the visibility pipeline (feeds the tier-2 hint). */
export interface VisibleSkill extends SkillIndexEntry {
	tags: string[];
}

/** Description cap in `core` and outside-root entries. */
export const CORE_DESC_MAX = DESCRIPTION_SOFT_LIMIT;
/**
 * Small sets keep descriptions: when every in-root skill fits with a
 * CORE_DESC_MAX description inside this many chars (≈1.5k tok), the catalog
 * lists them all with descriptions (no core group needed); above it, the
 * names-only category lines + core group take over. Names-only only pays
 * off at a few hundred skills — below that it just drops the "Use when …"
 * trigger text. Decided once per session with the catalog (cache-stable).
 */
export const FULL_CATALOG_MAX_CHARS = 6000;

export interface IndexTransformResult {
	/** The re-emitted `<available_skills>…</available_skills>` block. */
	block: string;
	hidden: string[];
	core: string[];
	flagged: string[];
	visible: VisibleSkill[];
}

const NATIVE_BLOCK_RE = /<available_skills>[\s\S]*?<\/available_skills>/;

/** Swap the native block in `systemPrompt` for `block` (unchanged when absent). */
export function replaceSkillsBlock(
	systemPrompt: string,
	block: string,
): string {
	const m = NATIVE_BLOCK_RE.exec(systemPrompt);
	if (!m) return systemPrompt;
	return (
		systemPrompt.slice(0, m.index) +
		block +
		systemPrompt.slice(m.index + m[0].length)
	);
}

export function transformSkillsIndex(
	systemPrompt: string,
	deps: IndexTransformDeps,
): IndexTransformResult | null {
	const blockMatch = NATIVE_BLOCK_RE.exec(systemPrompt);
	if (!blockMatch) return null;

	const entryRe =
		/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
	const entries: SkillIndexEntry[] = [];
	for (const m of blockMatch[0].matchAll(entryRe)) {
		entries.push({
			name: unescapeXml(m[1] ?? "").trim(),
			description: unescapeXml(m[2] ?? "").trim(),
			location: unescapeXml(m[3] ?? "").trim(),
		});
	}
	// Zero entries parsed → we don't understand the native format anymore.
	if (entries.length === 0) return null;

	// Step 1–3: visibility hides.
	const visible: Array<{ entry: SkillIndexEntry; meta: SkillMeta | null }> = [];
	const hidden: string[] = [];
	const hostNames = hostPlatformNames(deps.hostPlatform);
	const cwdSegments = deps.cwd.split(sep).filter((s) => s.length > 0);
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
		const dirs = stringArray(meta?.dirs);
		if (dirs.length > 0 && !dirs.some((d) => cwdSegments.includes(d))) {
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

	const flagged: string[] = [];
	const malformed = (meta: SkillMeta | null) =>
		meta === null || meta.malformed === true;
	const rows = visible.map(({ entry, meta }) => {
		const bad = malformed(meta);
		if (bad) flagged.push(entry.name);
		return {
			entry,
			bad,
			category: categoryOf(entry.location, deps.skillsRoot),
			tags: stringArray(meta?.tags),
		};
	});
	type CatalogRow = (typeof rows)[number];
	const inRoot = rows.filter((r) => r.category !== "other");
	const external = rows.filter((r) => r.category === "other");

	// core: most-used in-root skills. Cold start (no usage yet) → no core
	// group at all rather than padding it with arbitrary skills.
	const coreRows = inRoot
		.filter((r) => (deps.usage.get(r.entry.name) ?? 0) > 0)
		.sort(
			(a, b) =>
				(deps.usage.get(b.entry.name) ?? 0) -
					(deps.usage.get(a.entry.name) ?? 0) ||
				a.entry.name.localeCompare(b.entry.name),
		)
		.slice(0, deps.coreLimit);

	const flag = (bad: boolean) => (bad ? " ⚠ malformed frontmatter" : "");
	const lines: string[] = ["<available_skills>"];
	const header = `# categories in ${escapeXml(deps.skillsRoot)} — file = <category>/<name>/SKILL.md (${UNCATEGORIZED}: <name>/SKILL.md)`;
	const sortedInRoot = [...inRoot].sort(
		(a, b) =>
			Number(a.category === UNCATEGORIZED) -
				Number(b.category === UNCATEGORIZED) ||
			a.category.localeCompare(b.category) ||
			a.entry.name.localeCompare(b.entry.name),
	);
	const fullLines = sortedInRoot.map(({ entry, bad, category }) => {
		const catAttr =
			category === UNCATEGORIZED ? "" : ` category="${escapeXml(category)}"`;
		return `  <skill name="${escapeXml(entry.name)}"${catAttr}>${escapeXml(truncateDesc(entry.description, CORE_DESC_MAX))}${flag(bad)}</skill>`;
	});
	const fullFits =
		fullLines.reduce((n, l) => n + l.length + 1, 0) <=
		(deps.fullCatalogMaxChars ?? FULL_CATALOG_MAX_CHARS);
	let core: CatalogRow[] = [];

	if (inRoot.length > 0 && fullFits) {
		lines.push(header, ...fullLines);
	} else if (inRoot.length > 0) {
		core = coreRows;
		if (core.length > 0) {
			lines.push("# core (most used)");
			for (const { entry, bad, category } of core) {
				lines.push(
					`  <skill name="${escapeXml(entry.name)}" category="${escapeXml(category)}">${escapeXml(truncateDesc(entry.description, CORE_DESC_MAX))}${flag(bad)}</skill>`,
				);
			}
		}
		lines.push(header);
		const byCategory = new Map<string, string[]>();
		for (const { entry, bad, category } of sortedInRoot) {
			const names = byCategory.get(category) ?? [];
			names.push(`${entry.name}${bad ? "⚠" : ""}`);
			byCategory.set(category, names);
		}
		for (const [category, names] of byCategory) {
			lines.push(
				`  <category name="${escapeXml(category)}">${escapeXml(names.join(", "))}</category>`,
			);
		}
	}

	// Outside the skills root (project / extension-contributed): one group per
	// root, short descriptions. `location=` only when the same name lives under
	// two roots (native collision case — the attr then disambiguates).
	const rootsByName = new Map<string, Set<string>>();
	for (const { entry } of rows) {
		const root = rootOf(entry.location, deps.knownRoots);
		const roots = rootsByName.get(entry.name) ?? new Set<string>();
		roots.add(root);
		rootsByName.set(entry.name, roots);
	}
	let currentRoot: string | null = null;
	for (const { entry, bad } of external) {
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
			`  <skill name="${escapeXml(entry.name)}"${locationAttr}>${escapeXml(truncateDesc(entry.description, CORE_DESC_MAX))}${flag(bad)}</skill>`,
		);
	}

	// Own section so the pointer never reads as an entry of the group above.
	if (hidden.length > 0) {
		lines.push(
			"",
			"# hidden",
			`  ${hidden.length} hidden by platforms/requires/dirs — ls ${deps.skillsRoot} or /skill:<name>`,
		);
	}
	lines.push("</available_skills>");

	return {
		block: lines.join("\n"),
		hidden,
		core: core.map((r) => r.entry.name),
		flagged,
		visible: rows.map((r) => ({ ...r.entry, tags: r.tags })),
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
		dirs: fm.dirs,
		tags: fm.tags,
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

export function stringArray(value: unknown): string[] {
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

/** Display name for skills sitting directly under the skills root. */
const UNCATEGORIZED = "uncategorized";

/**
 * Category = the skill dir's PARENT relative to the skills root (layout:
 * <skillsRoot>/<category>/<name>/SKILL.md; root-level skills are legacy and
 * group under "uncategorized", external locations under "other").
 */
export function categoryOf(location: string, skillsRoot: string): string {
	const rel = relative(skillsRoot, dirname(dirname(location)));
	if (rel.startsWith("..")) return "other";
	return rel.length === 0 ? UNCATEGORIZED : rel;
}

/**
 * One-line description: the first sentence when it fits `max`, else a
 * word-boundary cut with an ellipsis.
 */
export function truncateDesc(desc: string, max: number): string {
	const flat = desc.replace(/\s+/g, " ").trim();
	const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
	if (sentence.length <= max) return sentence;
	const cut = flat.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
