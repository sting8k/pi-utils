/**
 * US-004 — SKILL.md frontmatter: shared parser + create-time validation.
 *
 * ONE parser serves both `skill_write` validation and the smart index
 * transform. Native (pi core) owns the full format contract and diagnostics;
 * we validate just enough to never write a broken file, and parse leniently
 * for visibility filtering. Unknown fields (incl. native flags like
 * `disable-model-invocation`) pass through untouched.
 *
 * Pure module: no pi imports, no direct fs access.
 */
import { parse as parseYaml } from "yaml";

/** Same shape for skill `name` and a single `category` dir segment. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const SKILL_NAME_MAX = 64;

/** Description length above which create carries an ADVISORY warning. */
export const DESCRIPTION_SOFT_LIMIT = 60;

export type FrontmatterResult =
	| { ok: true; frontmatter: Record<string, unknown>; body: string }
	| { ok: false; error: string };

/**
 * Parse `---\n…\n---` frontmatter off a SKILL.md. Strict per the create
 * contract: content non-empty, starts with `---`, frontmatter closes, YAML
 * parses to a mapping, body non-empty. Errors name the fix.
 */
export function parseSkillFile(content: string): FrontmatterResult {
	if (!content || content.trim().length === 0) {
		return {
			ok: false,
			error: "content is empty — pass the full SKILL.md text",
		};
	}
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") {
		return {
			ok: false,
			error: 'content must start with "---" YAML frontmatter delimiter',
		};
	}
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) {
		return { ok: false, error: 'frontmatter is not closed — add a "---" line' };
	}
	const fmText = lines.slice(1, close).join("\n");
	const body = lines.slice(close + 1).join("\n");
	let parsed: unknown;
	try {
		parsed = parseYaml(fmText);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `frontmatter YAML does not parse: ${message}` };
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		(parsed as object) instanceof Date
	) {
		return {
			ok: false,
			error: "frontmatter must parse to a YAML mapping (key: value lines)",
		};
	}
	if (body.trim().length === 0) {
		return {
			ok: false,
			error: "body is empty — add the skill's rules/instructions",
		};
	}
	return {
		ok: true,
		frontmatter: parsed as Record<string, unknown>,
		body,
	};
}

/**
 * Lenient variant for the index transform: frontmatter mapping only, body
 * irrelevant. Returns null on any deviation (the transform flags the entry
 * instead of failing).
 */
export function parseFrontmatterLenient(
	content: string,
): Record<string, unknown> | null {
	const result = parseSkillFile(content);
	return result.ok ? result.frontmatter : null;
}

export interface CreateValidation {
	/** Hard errors — create must not proceed. */
	errors: string[];
	/** Advisory notes — surfaced in the response, never blocking. */
	warnings: string[];
	frontmatter: Record<string, unknown> | null;
}

/** Validate a `create` payload (create only — patch/delete skip this). */
export function validateCreate(
	content: string,
	category?: string,
): CreateValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const parsed = parseSkillFile(content);
	if (!parsed.ok) {
		return { errors: [parsed.error], warnings, frontmatter: null };
	}
	const fm = parsed.frontmatter;

	const name = fm.name;
	if (typeof name !== "string" || name.length === 0) {
		errors.push('frontmatter needs a "name:" field');
	} else if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) {
		errors.push(
			`"name: ${name}" invalid — must match ^[a-z0-9][a-z0-9_-]*$ (≤${SKILL_NAME_MAX} chars)`,
		);
	}

	const description = fm.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		errors.push(
			'frontmatter needs a "description:" field — use "Use when <trigger>"',
		);
	} else if (description.length > DESCRIPTION_SOFT_LIMIT) {
		warnings.push(
			`description is ${description.length} chars — the native index renders it in full (prompt bloat); consider ≤${DESCRIPTION_SOFT_LIMIT}`,
		);
	}

	if (category !== undefined) {
		if (
			!SKILL_NAME_RE.test(category) ||
			category.includes("/") ||
			category.includes("\\")
		) {
			errors.push(
				`category "${category}" invalid — a single directory name matching ^[a-z0-9][a-z0-9_-]*$`,
			);
		}
	}

	return { errors, warnings, frontmatter: fm };
}
