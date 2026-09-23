/**
 * Argument normalization + validation for the script-only edit override
 * (US-003). One form only: `code` + `paths` (+ `lang`, `timeout`).
 *
 * Structured-form fields (path/edits/oldText/newText/all and their aliases)
 * are a HARD error naming the fix (owner decision): a model sending them is
 * confusing tools, and the error teaches the contract for later calls —
 * lenient merging would reintroduce the ambiguity the rule exists to kill.
 */
import type { FileChange } from "./run-script.ts";

export interface EditScriptArgs {
	code: string;
	paths: string[];
	lang?: "python" | "node";
	timeout?: number;
}

const CODE_ALIASES = ["script", "source"] as const;
const PATHS_ALIASES = ["files", "targets"] as const;

/** Single-path aliases are NOT normalized — they error and point to paths. */
const PATH_ALIASES = ["file_path", "file", "filename", "target_file"] as const;

/** Structured-form fields that must never appear on this tool. */
const STRAY_FIELDS: Record<string, string> = {
	path: 'declare files in "paths"',
	edits: "this tool only runs scripts — pass code with paths",
	oldText: "this tool only runs scripts — pass code with paths",
	newText: "this tool only runs scripts — pass code with paths",
	all: 'script mode replaces everything the script does — drop "all"',
	old_string: "anchored text edits are not a field here — pass code with paths",
	old: "anchored text edits are not a field here — pass code with paths",
	from: "anchored text edits are not a field here — pass code with paths",
	oldString: "anchored text edits are not a field here — pass code with paths",
	new_string: "anchored text edits are not a field here — pass code with paths",
	new: "anchored text edits are not a field here — pass code with paths",
	to: "anchored text edits are not a field here — pass code with paths",
	newString: "anchored text edits are not a field here — pass code with paths",
};

function firstDefined(
	raw: Record<string, unknown>,
	keys: readonly string[],
): unknown {
	for (const key of keys) {
		if (raw[key] !== undefined) return raw[key];
	}
	return undefined;
}

/**
 * Alias normalization (prepareArguments phase — runs BEFORE validation so
 * the stray-field errors fire on canonical names too). Canonical fields win
 * when both canonical and alias are present.
 */
export function normalizeEditArgs(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return input as Record<string, unknown>;
	}
	const raw = { ...(input as Record<string, unknown>) };

	if (raw.code === undefined) {
		const aliased = firstDefined(raw, CODE_ALIASES);
		if (aliased !== undefined) {
			raw.code = aliased;
			for (const key of CODE_ALIASES) delete raw[key];
		}
	}
	if (raw.paths === undefined) {
		const aliased = firstDefined(raw, PATHS_ALIASES);
		if (aliased !== undefined) {
			raw.paths = aliased;
			for (const key of PATHS_ALIASES) delete raw[key];
		}
	}
	if (raw.timeout === undefined && raw.timeoutMs !== undefined) {
		raw.timeout =
			typeof raw.timeoutMs === "number" ? raw.timeoutMs / 1000 : raw.timeoutMs;
	}
	delete raw.timeoutMs;
	return raw;
}

const MINIMAL_EXAMPLE =
	'{"code": "replace_once(\'a.txt\', \'old\', \'new\')", "paths": ["a.txt"]}';

/** Validate normalized args; throws errors that name the fix. */
export function resolveEditArgs(raw: Record<string, unknown>): EditScriptArgs {
	for (const [key, fix] of Object.entries(STRAY_FIELDS)) {
		if (raw[key] !== undefined) {
			throw new Error(`script-mode edit: "${key}" is not a field — ${fix}`);
		}
	}
	for (const key of PATH_ALIASES) {
		if (raw[key] !== undefined) {
			throw new Error(
				`script-mode edit: "${key}" is not a field — declare files in "paths"`,
			);
		}
	}

	if (typeof raw.code !== "string" || raw.code.length === 0) {
		throw new Error(
			`script-mode edit: "code" is required — a python/node script run against the declared files, e.g. ${MINIMAL_EXAMPLE}`,
		);
	}
	const paths = raw.paths;
	const validPaths =
		Array.isArray(paths) &&
		paths.length > 0 &&
		paths.every((p) => typeof p === "string" && p.length > 0);
	if (!validPaths) {
		throw new Error(
			'script-mode edit: "paths" is required — declare every file the script may touch (the tool can only diff and roll back declared paths)',
		);
	}
	if (raw.lang !== undefined && raw.lang !== "python" && raw.lang !== "node") {
		throw new Error('script-mode edit: "lang" must be "python" or "node"');
	}
	if (
		raw.timeout !== undefined &&
		(typeof raw.timeout !== "number" || !(raw.timeout > 0))
	) {
		throw new Error(
			'script-mode edit: "timeout" must be a positive number of seconds',
		);
	}
	return {
		code: raw.code as string,
		paths: paths as string[],
		lang: raw.lang as "python" | "node" | undefined,
		timeout: raw.timeout as number | undefined,
	};
}

/** Result-side types re-exported for the extension layer's convenience. */
export type { FileChange };
