/**
 * Settings for all pi-utils extensions — ONE file: <agentDir>/pi-utils.json.
 *
 * Decision 0008 (amended 2026-09-15): single auto-scaffolded file, no
 * per-extension or per-project files. First run writes the full defaults
 * template. Later runs auto-add MISSING sections/keys with their defaults —
 * both in memory and back to disk (best-effort, 2-space + trailing newline) —
 * while never touching existing values (even invalid ones) and never removing
 * unknown keys the user added. Parse errors fall back to defaults with
 * warnings and leave the broken file untouched — the caller surfaces them via
 * ctx.ui.notify.
 *
 * No imports from pi packages: agentDir is injected by the extension layer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FsSearchSettings {
	/** Search gitignored files by default (dsh discovery semantics). */
	noIgnore: boolean;
	globMaxResults: number;
	grepMaxMatches: number;
	grepMaxLineBytes: number;
	rawOutputMaxBytes: number;
	timeoutMs: number;
	graceMs: number;
}

export interface ShellBgSettings {
	autoBackgroundMs: number;
	tailBytes: number;
	killGraceMs: number;
}

export interface BashRouterSettings {
	/**
	 * Leading wrapper tokens the bash router may strip (exactly one) before
	 * search matching — e.g. ["rtk"] when pi-ctx-kit rewrites commands into
	 * `rtk <command>` (US-001 Amendment A1). Unknown wrappers never strip.
	 */
	unwrapPrefixes: string[];
}

export interface EditSettings {
	/** Script-mode interpreter (US-003): "python" | "node". */
	lang: "python" | "node";
	/** Script-mode timeout in seconds; the whole process tree is killed past it. */
	timeoutSec: number;
}

export interface PiUtilsSettings {
	fsSearch: FsSearchSettings;
	shellBg: ShellBgSettings;
	bashRouter: BashRouterSettings;
	edit: EditSettings;
	/** Tools skipped at registration time (US-002). Names must be in KNOWN_TOOLS. */
	disabledTools: string[];
}

/** Every tool pi-utils can register — single source of truth for disabledTools. */
export const KNOWN_TOOLS = [
	"grep",
	"glob",
	"bash",
	"shell_status",
	"shell_kill",
	"edit",
] as const;

export const DEFAULT_SETTINGS: PiUtilsSettings = {
	fsSearch: {
		noIgnore: true,
		globMaxResults: 100,
		grepMaxMatches: 250,
		grepMaxLineBytes: 2000,
		rawOutputMaxBytes: 20 * 1024 * 1024,
		timeoutMs: 30_000,
		graceMs: 3_000,
	},
	shellBg: {
		autoBackgroundMs: 30_000,
		tailBytes: 8192,
		killGraceMs: 3_000,
	},
	bashRouter: {
		unwrapPrefixes: ["rtk"],
	},
	edit: {
		lang: "python",
		timeoutSec: 10,
	},
	disabledTools: [],
};

export interface SettingsLoadResult {
	settings: PiUtilsSettings;
	/** Non-fatal problems (parse error, invalid values). Keys fall back to defaults. */
	warnings: string[];
	/** True when the settings file was created by this call. */
	created: boolean;
	/**
	 * Sections/keys added to the disk file by the repair pass (owner decision
	 * 2026-09-15): e.g. "edit", "disabledTools", "fsSearch.graceMs". Empty
	 * when nothing was missing or the file could not be written.
	 */
	repaired: string[];
}

export function settingsFilePath(agentDir: string): string {
	return join(agentDir, "pi-utils.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function applyNum(
	target: Record<string, unknown>,
	raw: Record<string, unknown>,
	section: string,
	key: string,
	fallback: number,
	warnings: string[],
): void {
	if (!(key in raw)) return; // missing key keeps the default silently
	const value = positiveInt(raw[key]);
	if (value === undefined) {
		warnings.push(
			`"${section}.${key}" invalid (${JSON.stringify(raw[key])}) — using default ${fallback}`,
		);
		return;
	}
	target[key] = value;
}

function applyBool(
	target: Record<string, unknown>,
	raw: Record<string, unknown>,
	section: string,
	key: string,
	fallback: boolean,
	warnings: string[],
): void {
	if (!(key in raw)) return;
	const value = bool(raw[key]);
	if (value === undefined) {
		warnings.push(
			`"${section}.${key}" invalid (${JSON.stringify(raw[key])}) — using default ${fallback}`,
		);
		return;
	}
	target[key] = value;
}

/** Load settings from <agentDir>/pi-utils.json, scaffolding it on first run. */
export function loadSettings(agentDir: string): SettingsLoadResult {
	const file = settingsFilePath(agentDir);
	try {
		mkdirSync(agentDir, { recursive: true });
	} catch {
		// Read-only agent dir: proceed with defaults, no scaffold.
	}

	if (!existsSync(file)) {
		try {
			writeFileSync(file, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
			return {
				settings: structuredClone(DEFAULT_SETTINGS),
				warnings: [],
				created: true,
				repaired: [],
			};
		} catch {
			// Cannot scaffold (permissions?) — still work with defaults.
			return {
				settings: structuredClone(DEFAULT_SETTINGS),
				warnings: [],
				created: false,
				repaired: [],
			};
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			settings: structuredClone(DEFAULT_SETTINGS),
			warnings: [`pi-utils.json parse error: ${message} — using defaults`],
			created: false,
			// Parse error: never touch the broken file — defaults in memory only.
			repaired: [],
		};
	}

	const warnings: string[] = [];
	const settings = structuredClone(DEFAULT_SETTINGS);

	if (!isRecord(parsed)) {
		return {
			settings,
			warnings: ["pi-utils.json is not a JSON object — using defaults"],
			created: false,
			repaired: [],
		};
	}

	// Repair pass (owner decision 2026-09-15): add missing sections/keys with
	// their defaults to the file — silently, best-effort. Existing values are
	// never touched (even invalid ones) and unknown user keys are never
	// removed; array sections (disabledTools) are atomic.
	const merged = structuredClone(parsed) as Record<string, unknown>;
	const repaired: string[] = [];
	for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
		const current = merged[section];
		if (current === undefined) {
			merged[section] = structuredClone(defaults);
			repaired.push(section);
			continue;
		}
		if (!isRecord(current) || !isRecord(defaults)) continue; // atomic sections
		const record = current as Record<string, unknown>;
		for (const [key, value] of Object.entries(defaults)) {
			if (!(key in record)) {
				record[key] = structuredClone(value);
				repaired.push(`${section}.${key}`);
			}
		}
	}
	if (repaired.length > 0) {
		try {
			writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
		} catch {
			// Read-only dir: skip the disk repair; in-memory defaults still apply.
		}
	}

	const fsRaw = merged.fsSearch;
	if (fsRaw === undefined) {
		warnings.push('missing "fsSearch" section — using defaults');
	} else if (isRecord(fsRaw)) {
		const target = settings.fsSearch as unknown as Record<string, unknown>;
		const raw = fsRaw as Record<string, unknown>;
		for (const key of Object.keys(settings.fsSearch)) {
			const fallback = target[key];
			if (typeof fallback === "number") {
				applyNum(target, raw, "fsSearch", key, fallback, warnings);
			} else if (typeof fallback === "boolean") {
				applyBool(target, raw, "fsSearch", key, fallback, warnings);
			}
		}
	} else {
		warnings.push('"fsSearch" is not an object — using defaults');
	}

	const bgRaw = merged.shellBg;
	if (bgRaw === undefined) {
		warnings.push('missing "shellBg" section — using defaults');
	} else if (isRecord(bgRaw)) {
		const target = settings.shellBg as unknown as Record<string, unknown>;
		const raw = bgRaw as Record<string, unknown>;
		for (const key of Object.keys(settings.shellBg)) {
			const fallback = target[key];
			if (typeof fallback === "number") {
				applyNum(target, raw, "shellBg", key, fallback, warnings);
			}
		}
	} else {
		warnings.push('"shellBg" is not an object — using defaults');
	}

	// bashRouter (Amendment A1): sections from pre-amendment settings files are
	// filled silently — a warning toast on every session start would be noise.
	const brRaw = merged.bashRouter;
	if (brRaw !== undefined) {
		if (!isRecord(brRaw)) {
			warnings.push('"bashRouter" is not an object — using defaults');
		} else if ("unwrapPrefixes" in brRaw) {
			const value = brRaw.unwrapPrefixes;
			if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
				settings.bashRouter.unwrapPrefixes = [...(value as string[])];
			} else {
				warnings.push(
					`"bashRouter.unwrapPrefixes" invalid (${JSON.stringify(value)}) — using default`,
				);
			}
		}
	}

	// disabledTools (US-002): a missing key stays silent — pre-existing settings
	// files must not start warning (same precedent as bashRouter Amendment A1).
	const dtRaw = merged.disabledTools;
	if (dtRaw !== undefined) {
		if (!Array.isArray(dtRaw)) {
			warnings.push(
				`"disabledTools" invalid (${JSON.stringify(dtRaw)}) — using default`,
			);
		} else {
			const seen = new Set<string>();
			const dropped: string[] = [];
			for (const entry of dtRaw) {
				if (
					typeof entry !== "string" ||
					!(KNOWN_TOOLS as readonly string[]).includes(entry)
				) {
					dropped.push(JSON.stringify(entry)); // typo protection: name the bad entry
					continue;
				}
				seen.add(entry); // duplicates dedupe silently
			}
			if (dropped.length > 0) {
				warnings.push(
					`"disabledTools" ignores unknown entries: ${dropped.join(", ")}`,
				);
			}
			settings.disabledTools = [...seen];
		}
	}

	// edit (US-003): a missing section or key stays silent — same A1 precedent.
	const eRaw = merged.edit;
	if (eRaw !== undefined) {
		if (!isRecord(eRaw)) {
			warnings.push('"edit" is not an object — using defaults');
		} else {
			if ("lang" in eRaw) {
				const lang = eRaw.lang;
				if (lang === "python" || lang === "node") {
					settings.edit.lang = lang;
				} else {
					warnings.push(
						`"edit.lang" invalid (${JSON.stringify(lang)}) — using default`,
					);
				}
			}
			if ("timeoutSec" in eRaw) {
				const value = positiveInt(eRaw.timeoutSec);
				if (value === undefined) {
					warnings.push(
						`"edit.timeoutSec" invalid (${JSON.stringify(eRaw.timeoutSec)}) — using default`,
					);
				} else {
					settings.edit.timeoutSec = value;
				}
			}
		}
	}

	return { settings, warnings, created: false, repaired };
}
