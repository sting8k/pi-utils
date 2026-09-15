/**
 * Settings for all pi-utils extensions — ONE file: <agentDir>/pi-utils.json.
 *
 * Decision 0008: single auto-scaffolded file, no per-extension or per-project
 * files. First run writes the full defaults template. Later runs fill missing
 * keys with defaults IN MEMORY without rewriting the file, and never overwrite
 * values the user edited. Parse errors fall back to defaults with warnings —
 * the caller surfaces them via ctx.ui.notify.
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

export interface PiUtilsSettings {
	fsSearch: FsSearchSettings;
	shellBg: ShellBgSettings;
	bashRouter: BashRouterSettings;
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
	disabledTools: [],
};

export interface SettingsLoadResult {
	settings: PiUtilsSettings;
	/** Non-fatal problems (parse error, invalid values). Keys fall back to defaults. */
	warnings: string[];
	/** True when the settings file was created by this call. */
	created: boolean;
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
			};
		} catch {
			// Cannot scaffold (permissions?) — still work with defaults.
			return {
				settings: structuredClone(DEFAULT_SETTINGS),
				warnings: [],
				created: false,
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
		};
	}

	const warnings: string[] = [];
	const settings = structuredClone(DEFAULT_SETTINGS);

	if (!isRecord(parsed)) {
		return {
			settings,
			warnings: ["pi-utils.json is not a JSON object — using defaults"],
			created: false,
		};
	}

	const fsRaw = parsed.fsSearch;
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

	const bgRaw = parsed.shellBg;
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
	const brRaw = parsed.bashRouter;
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
	const dtRaw = parsed.disabledTools;
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

	return { settings, warnings, created: false };
}
