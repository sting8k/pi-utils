/**
 * pi-utils / edit — script-mode editing tool for the Pi coding agent.
 *
 * Registers `edit` (OVERRIDES the core tool): the model passes `code` +
 * `paths` (+ optional `lang`, `timeout`), a python/node script runs against
 * the declared files, and the result carries the unified diff in `content` —
 * the verification surface the model actually reads. Declared paths are the
 * whole contract boundary: the tool snapshots, diffs, and rolls back exactly
 * those (no git anywhere, owner decision).
 *
 * Not a security boundary: the script runs with full user privileges; this
 * is an ergonomics and safety layer (declared intent, diff, rollback).
 *
 * Settings: ~/.pi/agent/pi-utils.json ("edit" section; US-002 disabledTools
 * interplay — "edit" in KNOWN_TOOLS, disabling leaves core edit in charge).
 * No pi imports below the extension layer.
 */

import { isAbsolute, join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	type PiUtilsSettings,
} from "../src/common/settings.ts";
import { writeSpill } from "../src/common/tempfile.ts";
import { normalizeEditArgs, resolveEditArgs } from "../src/edit/args.ts";
import {
	countChanges,
	diffHunks,
	formatDiffs,
	unifiedPatch,
} from "../src/edit/diff.ts";
import { withPathLocks } from "../src/edit/mutation-queue.ts";
import {
	type FileChange,
	runEditScript,
	type ScriptOutcome,
} from "../src/edit/run-script.ts";
import {
	type DroidRenderers,
	loadDroidRenderers,
	withTiming,
} from "../src/render/droid.ts";
import {
	droidToolRender,
	editRenderers,
} from "../src/render/tool-renderers.ts";

const DIFF_MAX_LINES = 200;
const DIFF_MAX_BYTES = 50 * 1024;
const STDERR_EXCERPT_BYTES = 2000;

export default function editExtension(pi: ExtensionAPI) {
	let settings: PiUtilsSettings = DEFAULT_SETTINGS;

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadSettings(getAgentDir());
		settings = loaded.settings;
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-utils edit: ${warning}`, "warning");
		}
		// Adapt to @sting8k/pi-droid-styling when present (see render/droid.ts).
		const droid = await loadDroidRenderers();
		if (droid) registerTools(droid);
	});

	function registerEdit(droid: DroidRenderers | null): void {
		pi.registerTool({
			name: "edit",
			label: "edit",
			description:
				"Edit files by running a script; the unified diff is returned for verification.",
			promptSnippet:
				"Edit files via python/node script (code + paths); returns the unified diff; rollback on failure",
			promptGuidelines: [
				"Declare every file the script may touch in paths — the tool can only diff and roll back declared paths.",
				'Review the returned diff — a script that matched nothing still exits 0; check the "no declared file changed" warning.',
				"Do not embed large file contents or payloads in code — the script reads from disk; for large content, write the file first, then read it from the script.",
				"Do not shell out from the script (subprocess/os.system) — when a shell command is needed, call the bash tool directly.",
			],
			parameters: Type.Object({
				code: Type.String({
					description:
						"Python or node script source (passed on stdin). Read/write the declared files; exit 0 on success.",
				}),
				paths: Type.Array(Type.String(), {
					description:
						"Every file the script may touch (relative or absolute) — the tool snapshots, diffs, and rolls back exactly these paths",
				}),
				lang: Type.Optional(
					Type.Union([Type.Literal("python"), Type.Literal("node")], {
						description: "Interpreter (default from settings: python)",
					}),
				),
				timeout: Type.Optional(
					Type.Number({
						description:
							"Timeout in seconds — the whole process tree is killed past it and changes roll back (default from settings: 60)",
					}),
				),
			}),
			prepareArguments(args) {
				return normalizeEditArgs(args) as never;
			},
			...droidToolRender(droid, editRenderers),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return withTiming(async () => {
					const args = resolveEditArgs(normalizeEditArgs(params));
					// Display paths stay as passed; the filesystem sees resolved ones.
					const resolved = args.paths.map((p) =>
						isAbsolute(p) ? p : join(ctx.cwd, p),
					);
					// Lock the whole window (snapshot → script → diff → rollback)
					// per path, so concurrent calls never misattribute writes.
					const outcome = await withPathLocks(resolved, async () =>
						runEditScript({
							code: args.code,
							paths: resolved,
							lang: args.lang ?? settings.edit.lang,
							timeoutSec: args.timeout ?? settings.edit.timeoutSec,
							cwd: ctx.cwd,
							signal,
						}),
					);
					const display = new Map(
						resolved.map((abs, index) => [abs, args.paths[index]] as const),
					);
					const withDisplayPaths = (p: string): string => display.get(p) ?? p;
					const shown: ScriptOutcome = outcome.ok
						? {
								...outcome,
								changes: outcome.changes.map((change) => ({
									...change,
									path: withDisplayPaths(change.path),
								})),
							}
						: {
								...outcome,
								dirtyBeforeRestore:
									outcome.dirtyBeforeRestore.map(withDisplayPaths),
							};
					return buildResult(shown, args.lang ?? settings.edit.lang);
				});
			},
		});
	}

	function registerTools(droid: DroidRenderers | null): void {
		const disabled = new Set(settings.disabledTools);
		if (!disabled.has("edit")) registerEdit(droid);
	}

	// Load settings once at init so disabledTools gates the eager registration
	// below; session_start reloads (picks up edits before re-registering).
	settings = loadSettings(getAgentDir()).settings;
	registerTools(null);
}

function buildResult(
	outcome: ScriptOutcome,
	lang: "python" | "node",
): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
} {
	const shared = {
		lang,
		elapsedMs: outcome.elapsedMs,
		stdout: outcome.stdout,
		stderr: outcome.stderr,
		spillPath: outcome.spillPath,
	};

	if (!outcome.ok) {
		const lines = [
			`script edit failed (${outcome.timedOut ? "timeout" : outcome.aborted ? "aborted" : `exit ${outcome.exitCode ?? "unknown"}`}) — rolled back to snapshot.`,
		];
		if (outcome.dirtyBeforeRestore.length > 0) {
			lines.push(
				`Restored ${outcome.dirtyBeforeRestore.length} path(s) the script had touched: ${outcome.dirtyBeforeRestore.join(", ")}`,
			);
		}
		if (outcome.restoreFailures.length > 0) {
			lines.push(
				`RESTORE FAILED for: ${outcome.restoreFailures.join(", ")} — manual inspection required.`,
			);
		}
		const stderrExcerpt = outcome.stderr.slice(0, STDERR_EXCERPT_BYTES);
		if (stderrExcerpt.trim().length > 0) {
			lines.push(`stderr:\n${stderrExcerpt}`);
		}
		if (outcome.spawnError) lines.push(outcome.spawnError);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				...shared,
				diff: "",
				patch: "",
				firstChangedLine: undefined,
				filesChanged: [],
				rolledBack: true,
				exitCode: outcome.exitCode,
				dirtyBeforeRestore: outcome.dirtyBeforeRestore,
				restoreFailures: outcome.restoreFailures,
			},
			isError: true,
		};
	}

	const changes: FileChange[] = outcome.changes;
	const hunks = changes.flatMap((change) =>
		diffHunks(change.oldContent ?? "", change.newContent ?? ""),
	);
	const counts = countChanges(hunks);

	const details: Record<string, unknown> = {
		...shared,
		filesChanged: changes.map((change) => change.path),
		rolledBack: false,
		exitCode: 0,
	};

	if (changes.length === 0) {
		return {
			content: [
				{
					type: "text",
					text: "WARNING: script exited 0 but no declared file changed — the script matched nothing or wrote only outside the declared paths.",
				},
			],
			details: { ...details, diff: "", patch: "", firstChangedLine: undefined },
		};
	}

	const rendered = formatDiffs(hunks);
	const patch = unifiedPatch(
		changes.map((change) => ({
			path: change.path,
			oldContent: change.oldContent ?? "",
			newContent: change.newContent ?? "",
		})),
	);
	details.diff = rendered;
	details.patch = patch;
	details.firstChangedLine = hunks[0]?.newStart;

	const header = `script edit: ${changes.length} file(s) changed (+${counts.additions}/-${counts.removals}).`;
	return {
		content: [{ type: "text", text: `${header}\n${capDiff(rendered)}` }],
		details,
	};
}

/** Cap the rendered diff at ~200 lines / 50KB; overflow spills to a temp file. */
function capDiff(rendered: string): string {
	const overBytes = rendered.length > DIFF_MAX_BYTES;
	const lines = rendered.split("\n");
	const overLines = lines.length > DIFF_MAX_LINES;
	if (!overBytes && !overLines) return rendered;

	const trimmed = overLines
		? lines.slice(0, DIFF_MAX_LINES).join("\n")
		: rendered;
	const capped = overBytes ? trimmed.slice(0, DIFF_MAX_BYTES) : trimmed;
	const spillPath = writeSpill("edit-diff", rendered);
	return `${capped}\n[diff truncated — full diff at ${spillPath}]`;
}
