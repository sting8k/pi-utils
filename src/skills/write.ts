/**
 * US-004/US-005 — skill_write ops: create / patch / delete / move on SKILL.md
 * files under the native skills root (`<root>/<category>/<name>/`; root-level
 * skills are legacy). Every mutation follows the US-003 snapshot
 * discipline: snapshot → write → verify; any failure restores the snapshot
 * and the caller gets a fixable error. `skill_write` guards SKILL.md only —
 * supporting files (references/ etc.) are generic-file-tool territory.
 *
 * Path safety comes from the name/category regex (no separators, no dots),
 * so `join` can never escape the skills root.
 *
 * No pi imports. fs is injectable where tests need it; otherwise direct.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotPaths } from "../edit/snapshot.ts";
import {
	SKILL_NAME_MAX,
	SKILL_NAME_RE,
	validateCreate,
} from "./frontmatter.ts";

export const SKILL_MD = "SKILL.md";

export type OpResult =
	| { ok: true; path: string; warnings: string[]; extra?: string[] }
	| {
			ok: false;
			error: string;
			rolledBack: boolean;
			restoreFailures?: string[];
	  };

export interface SkillTarget {
	skillsRoot: string;
	name: string;
	category?: string;
	/** create/move only: allow `category` to be a directory that does not exist yet. */
	newCategory?: boolean;
}

export interface SkillLocation {
	dir: string;
	skillMd: string;
	/** undefined = legacy root-level skill. */
	category?: string;
}

export type LocateResult =
	| ({ ok: true } & SkillLocation)
	| { ok: false; error: string; missing?: boolean };

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Category dirs = valid-named directories under the root that are not themselves skills. */
function categoryDirs(skillsRoot: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(skillsRoot).sort();
	} catch {
		return [];
	}
	return entries.filter(
		(entry) =>
			SKILL_NAME_RE.test(entry) &&
			isDir(join(skillsRoot, entry)) &&
			!existsSync(join(skillsRoot, entry, SKILL_MD)),
	);
}

/** Categories with their skill counts, sorted by name. */
export function listCategories(
	skillsRoot: string,
): Array<{ name: string; count: number }> {
	return categoryDirs(skillsRoot).map((name) => {
		const dir = join(skillsRoot, name);
		const count = readdirSync(dir).filter((child) =>
			existsSync(join(dir, child, SKILL_MD)),
		).length;
		return { name, count };
	});
}

function categoryLine(skillsRoot: string): string {
	const cats = listCategories(skillsRoot);
	return `categories: ${cats.length > 0 ? cats.map((c) => `${c.name}(${c.count})`).join(" ") : "(none yet)"}`;
}

/** null = usable; otherwise the fixable error (create + move share it). */
function checkCategory(target: SkillTarget): string | null {
	const { skillsRoot, category } = target;
	if (!category) {
		return `category is required — ${categoryLine(skillsRoot)} — pick the one matching the context this skill is used in, or pass new_category:true with a new name`;
	}
	if (categoryDirs(skillsRoot).includes(category)) return null;
	if (existsSync(join(skillsRoot, category))) {
		return `"${category}" is a skill, not a category — ${categoryLine(skillsRoot)}`;
	}
	if (!target.newCategory) {
		return `category "${category}" does not exist — ${categoryLine(skillsRoot)} — pick one, or pass new_category:true to create it`;
	}
	return null;
}

/**
 * Find a skill by name across the root and its category dirs. `category`
 * narrows (and so disambiguates) but must not contradict where the skill is.
 */
export function locateSkill(
	skillsRoot: string,
	name: string,
	category?: string,
): LocateResult {
	const found: SkillLocation[] = [];
	for (const cat of [undefined, ...categoryDirs(skillsRoot)]) {
		const dir = join(skillsRoot, ...(cat ? [cat] : []), name);
		const skillMd = join(dir, SKILL_MD);
		if (existsSync(skillMd)) found.push({ dir, skillMd, category: cat });
	}
	if (found.length === 0) {
		return {
			ok: false,
			error: `no skill named "${name}" under ${skillsRoot} — create it with action:"create"`,
			missing: true,
		};
	}
	const where = (locs: SkillLocation[]) =>
		locs.map((loc) => loc.skillMd).join(", ");
	const candidates =
		category === undefined
			? found
			: found.filter((loc) => loc.category === category);
	if (candidates.length === 0) {
		return {
			ok: false,
			error: `skill "${name}" is not in category "${category}" — it lives at ${where(found)}`,
		};
	}
	if (candidates.length > 1) {
		return {
			ok: false,
			error: `skill name "${name}" is ambiguous — found at ${where(candidates)}; pass category to pick one`,
		};
	}
	return { ok: true, ...(candidates[0] as SkillLocation) };
}

/** Validate a skill name (all ops) / category (create) at the funnel. */
export function validateTarget(target: {
	name: string;
	category?: string;
}): string | null {
	if (!SKILL_NAME_RE.test(target.name) || target.name.length > SKILL_NAME_MAX) {
		return `skill name "${target.name}" invalid — must match ^[a-z0-9][a-z0-9_-]*$ (≤${SKILL_NAME_MAX} chars)`;
	}
	if (target.category !== undefined && !SKILL_NAME_RE.test(target.category)) {
		return `category "${target.category}" invalid — a single directory name matching ^[a-z0-9][a-z0-9_-]*$`;
	}
	return null;
}

/** Directory of a skill: `<skillsRoot>/[<category>/]<name>`. */
export function skillDir(target: SkillTarget): string {
	return join(
		target.skillsRoot,
		...(target.category ? [target.category] : []),
		target.name,
	);
}

/** Restore parent dirs first — snapshotPaths restores files, not dirs. */
function restoreSnapshot(
	entries: ReturnType<typeof snapshotPaths>["entries"],
): string[] {
	const failed: string[] = [];
	for (const entry of entries) {
		try {
			if (entry.present && entry.content !== null) {
				mkdirSync(dirname(entry.path), { recursive: true });
				writeFileSync(entry.path, entry.content);
			} else if (!entry.present) {
				rmSync(entry.path, { force: true });
			}
		} catch {
			failed.push(entry.path);
		}
	}
	return failed;
}

/** create: `<skillsRoot>/<category>/<name>/SKILL.md`. Exists anywhere → error naming patch. */
export function createSkill(target: SkillTarget, content: string): OpResult {
	const targetError = validateTarget(target) ?? checkCategory(target);
	if (targetError) return { ok: false, error: targetError, rolledBack: false };

	const validation = validateCreate(content, target.category);
	if (validation.errors.length > 0) {
		return {
			ok: false,
			error: `invalid SKILL.md content — ${validation.errors.join("; ")}`,
			rolledBack: false,
		};
	}

	const dir = skillDir(target);
	const path = join(dir, SKILL_MD);
	// Names are unique across the root (patch/delete/move locate by name).
	const existing = locateSkill(target.skillsRoot, target.name);
	if (existing.ok || !existing.missing) {
		return {
			ok: false,
			error: `skill already exists${existing.ok ? ` at ${existing.skillMd}` : ` (${existing.error})`} — use action:"patch" to modify it`,
			rolledBack: false,
		};
	}

	// Snapshot the (absent) target so a failed write can be undone.
	const snapshot = snapshotPaths([path]);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, content);
		// Verify: read-back must equal what we meant to write.
		const readBack = readFileSync(path);
		if (!readBack.equals(Buffer.from(content, "utf8"))) {
			throw new Error("read-back mismatch");
		}
		return { ok: true, path, warnings: validation.warnings };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed = restoreSnapshot(snapshot.entries);
		return {
			ok: false,
			error: `create failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/**
 * Patch fuzzy-match semantics: exact match first; on miss, retry against the
 * fuzzy-normalized view (trailing whitespace stripped per line, smart
 * quotes/dashes/special spaces → ASCII — same progression as pi's core edit).
 * A fuzzy hit rewrites the normalized view back (fine for our LF-authored
 * markdown; content is otherwise identical).
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

function replaceAllOccurrences(
	haystack: string,
	needle: string,
	replacement: string,
): string {
	return haystack.split(needle).join(replacement);
}

/** patch: old_string → new_string on SKILL.md (fuzzy fallback, replace_all opt). */
export function patchSkill(
	skillMdPath: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): OpResult {
	if (oldString.length === 0) {
		return {
			ok: false,
			error: "old_string is empty — pass the text to replace",
			rolledBack: false,
		};
	}
	let content: string;
	try {
		content = readFileSync(skillMdPath, "utf8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `cannot read ${skillMdPath}: ${message}`,
			rolledBack: false,
		};
	}

	let base = content;
	let search = oldString;
	let usedFuzzy = false;
	let occurrences = countOccurrences(base, search);
	if (occurrences === 0) {
		base = normalizeForFuzzyMatch(content);
		search = normalizeForFuzzyMatch(oldString);
		usedFuzzy = true;
		occurrences = countOccurrences(base, search);
	}
	if (occurrences === 0) {
		return {
			ok: false,
			error: `old_string not found in ${SKILL_MD} — read the skill and copy the text exactly`,
			rolledBack: false,
		};
	}
	if (occurrences > 1 && !replaceAll) {
		return {
			ok: false,
			error: `old_string matches ${occurrences} locations — make it unique or pass replace_all:true`,
			rolledBack: false,
		};
	}
	const updated = replaceAllOccurrences(base, search, newString);
	if (updated === base) {
		return {
			ok: false,
			error: "old_string equals new_string — nothing to change",
			rolledBack: false,
		};
	}

	const snapshot = snapshotPaths([skillMdPath]);
	try {
		writeFileSync(skillMdPath, updated);
		const readBack = readFileSync(skillMdPath, "utf8");
		if (readBack !== updated) throw new Error("read-back mismatch");
		return {
			ok: true,
			path: skillMdPath,
			warnings: usedFuzzy
				? ["old_string matched after fuzzy normalization (whitespace/quotes)"]
				: [],
			extra: [`${occurrences} replacement${occurrences > 1 ? "s" : ""}`],
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed = restoreSnapshot(snapshot.entries);
		return {
			ok: false,
			error: `patch failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back to snapshot"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/** Collect every file under dir (recursive). */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

/** delete: remove the skill dir; every file snapshot-restorable on failure. */
export function deleteSkill(skillDirectory: string): OpResult {
	if (!existsSync(skillDirectory)) {
		return {
			ok: false,
			error: `no skill directory at ${skillDirectory} — nothing to delete`,
			rolledBack: false,
		};
	}
	const files = listFiles(skillDirectory);
	if (files.length === 0) {
		return {
			ok: false,
			error: `${skillDirectory} contains no files — not a skill; refusing to blind-delete`,
			rolledBack: false,
		};
	}
	if (
		!files.some(
			(file) =>
				file.endsWith(`/${SKILL_MD}`) ||
				file === join(skillDirectory, SKILL_MD),
		)
	) {
		return {
			ok: false,
			error: `no ${SKILL_MD} in ${skillDirectory} — not a skill; refusing to delete`,
			rolledBack: false,
		};
	}

	const snapshot = snapshotPaths(files);
	try {
		rmSync(skillDirectory, { recursive: true });
		if (existsSync(skillDirectory))
			throw new Error("directory still present after delete");
		return { ok: true, path: skillDirectory, warnings: [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed = restoreSnapshot(snapshot.entries);
		return {
			ok: false,
			error: `delete failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/**
 * move: relocate a located skill dir into `target.category` (rename — atomic
 * on one filesystem; a symlinked skill moves as the symlink). Snapshot of the
 * skill's files taken first; any failure puts everything back and removes a
 * category dir this call created.
 */
export function moveSkill(from: SkillLocation, target: SkillTarget): OpResult {
	const targetError = validateTarget(target) ?? checkCategory(target);
	if (targetError) return { ok: false, error: targetError, rolledBack: false };
	if (from.category === target.category) {
		return {
			ok: false,
			error: `skill "${target.name}" is already in category "${target.category}"`,
			rolledBack: false,
		};
	}
	const dest = skillDir(target);
	if (existsSync(dest)) {
		return {
			ok: false,
			error: `${dest} already exists — cannot move onto it`,
			rolledBack: false,
		};
	}

	const categoryDir = dirname(dest);
	const createdCategory = !existsSync(categoryDir);
	const snapshot = snapshotPaths(listFiles(from.dir));
	try {
		mkdirSync(categoryDir, { recursive: true });
		renameSync(from.dir, dest);
		if (!existsSync(join(dest, SKILL_MD)) || existsSync(from.dir)) {
			throw new Error("move did not land as expected");
		}
		return { ok: true, path: join(dest, SKILL_MD), warnings: [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failed: string[] = [];
		try {
			if (existsSync(dest) && !existsSync(from.dir)) renameSync(dest, from.dir);
		} catch {
			failed.push(dest);
		}
		failed.push(...restoreSnapshot(snapshot.entries));
		if (createdCategory) {
			try {
				rmdirSync(categoryDir); // only succeeds when empty
			} catch {
				// leave a non-empty dir alone
			}
		}
		return {
			ok: false,
			error: `move failed (${message})${failed.length > 0 ? ` — RESTORE FAILED for ${failed.join(", ")}` : " — rolled back"}`,
			rolledBack: true,
			restoreFailures: failed.length > 0 ? failed : undefined,
		};
	}
}

/**
 * Resolve a read-tool path to a SKILL.md under skillsRoot — null when the
 * path is not a SKILL.md or lies outside the root (the seen-map keys on
 * these; the guard and the index "recently-used" check share it).
 *
 * Mirrors pi's read-tool resolution (utils/paths.js resolvePath: unicode
 * spaces → " ", strip leading "@", expand "~", file:// URLs, then
 * path.resolve) — any path read() accepts must mark the same key the
 * guard later checks with resolve(), or a real read is rejected as unread.
 */
export function resolveSkillMdPath(
	path: string,
	skillsRoot: string,
	cwd: string,
	homeDir: string = homedir(),
): string | null {
	let input = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (input.startsWith("@")) input = input.slice(1);
	if (input === "~") input = homeDir;
	else if (input.startsWith("~/")) input = join(homeDir, input.slice(2));
	else if (input.startsWith("file://")) input = fileURLToPath(input);
	const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
	if (absolute.split("/").pop() !== SKILL_MD) return null;
	const rel = relative(skillsRoot, absolute);
	if (rel.length === 0 || rel.startsWith("..")) return null;
	return absolute;
}
