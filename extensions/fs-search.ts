/**
 * pi-utils / fs-search — deep search tools for the Pi coding agent.
 *
 * Registers:
 *   - `grep` (OVERRIDES the built-in): streaming ripgrep content search that
 *     by default ALSO searches gitignored files (dsh discovery semantics) and
 *     always prepends --no-config; merged design per decision 0008 — fork of
 *     pi's streaming implementation (MIT) plus dsh flags, timeout, caps.
 *   - `glob` (new tool): file discovery by name pattern, mtime-sorted,
 *     includes hidden + gitignored files. Built-in `find` stays untouched.
 *
 * Settings: ~/.pi/agent/pi-utils.json (single file, auto-scaffolded).
 * rg binary: PATH → pi's <agentDir>/bin (D3). No pi imports below the
 * extension layer.
 */
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveRg } from "../src/common/rg-resolver.ts";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	type PiUtilsSettings,
} from "../src/common/settings.ts";
import { cleanupSpills } from "../src/common/tempfile.ts";
import { runGlob } from "../src/fs-search/glob-core.ts";
import { runGrep } from "../src/fs-search/grep-core.ts";
import {
	type DroidRenderers,
	loadDroidRenderers,
	withTiming,
} from "../src/render/droid.ts";
import {
	droidToolRender,
	globRenderers,
	grepRenderers,
} from "../src/render/tool-renderers.ts";

export default function fsSearchExtension(pi: ExtensionAPI) {
	let settings: PiUtilsSettings = DEFAULT_SETTINGS;
	let rgPath: string | null = null;

	function rg(): string {
		if (rgPath === null) rgPath = resolveRg(getAgentDir());
		return rgPath;
	}

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadSettings(getAgentDir());
		settings = loaded.settings;
		if (loaded.created) {
			ctx.ui.notify(
				`pi-utils: settings scaffolded at ${getAgentDir()}/pi-utils.json`,
				"info",
			);
		}
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-utils: ${warning}`, "warning");
		}
		cleanupSpills();
		try {
			rgPath = resolveRg(getAgentDir());
		} catch (err) {
			ctx.ui.notify(
				`pi-utils: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
		// Adapt to @sting8k/pi-droid-styling when present: re-register the tools
		// with its renderer primitives; absent → default rendering stays.
		const droid = await loadDroidRenderers();
		if (droid) registerTools(droid);
	});

	function registerTools(droid: DroidRenderers | null): void {
		pi.registerTool({
			name: "grep",
			label: "grep",
			description:
				"Search file contents by regex (ripgrep syntax). By default searches hidden AND gitignored " +
				"files (.git excluded) — set noIgnore:false to respect ignore files. Rows are 'path:line: text'; " +
				"feed line numbers into read offset. No matches is a successful empty result. Output is capped " +
				"(limit matches, 50KB inline); when the byte cap hits, the full output is written to a temp file " +
				"and referenced by path. Errors carry SEARCH_INVALID_PATTERN / SEARCH_FAILED / SEARCH_ABORTED / " +
				"SEARCH_RAW_OUTPUT_OVERFLOW prefixes.",
			promptSnippet:
				"Content search by regex (ripgrep); searches gitignored files too (noIgnore:false to respect ignores); rows are path:line: text",
			promptGuidelines: [
				"Use grep for code and content search — it also searches gitignored files; pass noIgnore:false when ignores should be respected.",
			],
			parameters: Type.Object({
				pattern: Type.String({ description: "Regex pattern (ripgrep syntax)" }),
				path: Type.Optional(
					Type.String({
						description:
							"Directory or file to search (default: current directory)",
					}),
				),
				include: Type.Optional(
					Type.String({
						description:
							"Single positive glob filter for file names, e.g. '*.ts'. No comma lists, no negation.",
					}),
				),
				glob: Type.Optional(
					Type.String({ description: "Alias of include (compatibility)" }),
				),
				ignoreCase: Type.Optional(
					Type.Boolean({
						description: "Case-insensitive search (default: false)",
					}),
				),
				literal: Type.Optional(
					Type.Boolean({
						description:
							"Treat pattern as a literal string instead of regex (default: false)",
					}),
				),
				context: Type.Optional(
					Type.Number({
						description: "Context lines to show around each match (default: 0)",
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description: "Maximum matches to return (default: 250)",
					}),
				),
				noIgnore: Type.Optional(
					Type.Boolean({
						description:
							"Include gitignored files in the search (default: true)",
					}),
				),
			}),
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args as never;
				const input = args as {
					path?: unknown;
					include?: unknown;
					glob?: unknown;
				};
				const next = { ...(args as object) };
				if (typeof input.glob === "string" && input.include === undefined) {
					(next as { include?: unknown }).include = input.glob;
				}
				if (typeof input.path === "string" && input.path.startsWith("@")) {
					(next as { path?: unknown }).path = input.path.slice(1);
				}
				return next as never;
			},
			...droidToolRender(droid, grepRenderers),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return withTiming(async () => {
					const result = await runGrep(
						rg(),
						params,
						settings.fsSearch,
						ctx.cwd,
						signal,
					);
					return {
						content: [{ type: "text" as const, text: result.text }],
						details: {
							matchCount: result.matchCount,
							fileCount: result.fileCount,
							matchLimitReached: result.matchLimitReached,
							spillPath: result.spillPath,
						},
					};
				});
			},
		});

		pi.registerTool({
			name: "glob",
			label: "glob",
			description:
				"Find files by glob pattern. A pattern without '/' matches the basename at ANY depth (e.g. " +
				"'*.test.js' matches nested files too); add '/' to anchor to the search root (e.g. 'src/*.ts'). " +
				"Includes hidden and gitignored files; .git excluded. Paths are relative to the working " +
				"directory, sorted by modification time ascending (recently modified files last). Results are " +
				"capped; the full list is written to a temp file and referenced by path.",
			promptSnippet:
				"File search by name pattern across all depths; includes gitignored files; mtime-sorted (recent last)",
			promptGuidelines: [
				"Use glob to locate files by name — results are sorted by mtime with the most recently modified files last.",
			],
			parameters: Type.Object({
				pattern: Type.String({
					description: "Glob pattern, e.g. '*.md' or 'src/*.ts'",
				}),
				path: Type.Optional(
					Type.String({
						description: "Directory to search (default: current directory)",
					}),
				),
			}),
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args as never;
				const input = args as { path?: unknown };
				if (typeof input.path === "string" && input.path.startsWith("@")) {
					return { ...(args as object), path: input.path.slice(1) } as never;
				}
				return args as never;
			},
			...droidToolRender(droid, globRenderers),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return withTiming(async () => {
					const result = await runGlob(
						rg(),
						params,
						settings.fsSearch,
						ctx.cwd,
						signal,
					);
					return {
						content: [{ type: "text" as const, text: result.text }],
						details: { total: result.total, spillPath: result.spillPath },
					};
				});
			},
		});
	}

	registerTools(null);
}
