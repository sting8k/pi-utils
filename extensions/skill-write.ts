/**
 * pi-utils / skill-write — the write half of the self-improving skill loop
 * (US-004).
 *
 * Registers `skill_write` (create/patch/delete/move on SKILL.md under the native
 * skills root, single-op, snapshot rollback per the US-003 discipline) and
 * ONE before_agent_start handler that (a) swaps native's <available_skills>
 * block for the tier-1 catalog (config skills.index: smart | native) —
 * computed ONCE per session and reused verbatim, so the system prompt is
 * byte-stable across turns —, (b) appends the prompt rules block, and (c)
 * returns the tier-2 per-turn skill hint as a `message` (US-005). The
 * read-before-write guard uses one session seen-map keyed on read-tool calls
 * (bash cat never counts); successful SKILL.md reads also feed the
 * cross-session usage file that drives the catalog's `core` group.
 *
 * Discovery/injection stay native — we never rescan; we only transform the
 * block pi already rendered, and pass through untouched on any parse miss.
 *
 * Settings: ~/.pi/agent/pi-utils.json ("skills" section; "skill_write" in
 * KNOWN_TOOLS for disabledTools). No pi imports below the extension layer.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import { diffHunks, formatDiffs } from "../src/edit/diff.ts";
import {
	type DroidRenderers,
	loadDroidRenderers,
} from "../src/render/droid.ts";
import {
	droidToolRender,
	skillWriteRenderers,
} from "../src/render/tool-renderers.ts";
import {
	DESCRIPTION_SOFT_LIMIT,
	parseSkillFile,
} from "../src/skills/frontmatter.ts";
import {
	createRequiresChecker,
	createSeenMap,
	type SeenMap,
} from "../src/skills/guard.ts";
import {
	buildHintIndex,
	buildQuery,
	createActivityLog,
	formatHint,
	type HintIndex,
	rankHints,
} from "../src/skills/hint.ts";
import {
	replaceSkillsBlock,
	rootOf,
	type SkillMeta,
	transformSkillsIndex,
	type VisibleSkill,
} from "../src/skills/index-transform.ts";
import { createNudgeTracker } from "../src/skills/nudge.ts";
import { loadUsage, recordUse } from "../src/skills/usage.ts";
import {
	createSkill,
	deleteSkill,
	locateSkill,
	moveSkill,
	patchSkill,
	resolveSkillMdPath,
	SKILL_MD,
	validateTarget,
} from "../src/skills/write.ts";

const RULES_BLOCK = `
## Skills
Skills under ~/.pi/agent/skills/ are your learned procedures — scan
<available_skills> and load any relevant one with read() before
starting. If a skill is wrong or missing steps, patch it with
skill_write before finishing. After a hard task or a user
correction, save the lesson as a skill: class-level name (never
"fix-X-today"), description = "Use when <trigger>", rules with
why — not a session log. File it under the category matching the
context where it will be used.
`;

export default function skillWriteExtension(pi: ExtensionAPI) {
	let settings: PiUtilsSettings = DEFAULT_SETTINGS;
	let seen: SeenMap = createSeenMap();
	let metaCache = new Map<string, SkillMeta | null>();
	let pendingReads = new Map<string, string>(); // toolCallId → resolved SKILL.md
	let tracker = createNudgeTracker(DEFAULT_SETTINGS.skills.nudgeInterval);
	// Tier 1 (US-005): computed on the first before_agent_start of a session,
	// then reused verbatim. null = native block unparseable → passthrough.
	let catalog: { block: string; visible: VisibleSkill[] } | null | undefined;
	let hintIndex: HintIndex | undefined;
	let hinted = new Set<string>();
	let activity = createActivityLog();
	const skillsRoot = join(getAgentDir(), "skills");
	const usageFile = join(getAgentDir(), "pi-utils-skill-usage.json");
	const requiresCheck = createRequiresChecker(process.env);

	// KILL-SWITCH (bean): disabledTools matching "skill_write" (exact or
	// trailing-* pattern — already expanded to concrete names by loadSettings)
	// kills the WHOLE layer, not just the tool: no transform, no rules block,
	// no nudge. disabledTools is load-time-only (US-002) → computed once per
	// settings load, cached as a boolean.
	let layerEnabled = false;

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadSettings(getAgentDir());
		settings = loaded.settings;
		layerEnabled = !settings.disabledTools.includes("skill_write");
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-utils skill-write: ${warning}`, "warning");
		}
		// Session-scoped state resets here — seen-map, meta cache, nudge.
		seen = createSeenMap();
		metaCache = new Map();
		pendingReads = new Map();
		tracker = createNudgeTracker(settings.skills.nudgeInterval);
		catalog = undefined;
		hintIndex = undefined;
		hinted = new Set();
		activity = createActivityLog();
		const droid = await loadDroidRenderers();
		registerTool(droid);
	});

	// Read tracking: resolve the read input; mark seen only on a successful
	// result (tool_call fires before execution, tool_result after).
	pi.on("tool_call", (event, ctx) => {
		if (event.type !== "tool_call") return;
		const isSkillWrite = event.toolName === "skill_write";
		tracker.onToolCall(isSkillWrite);
		activity.note(event.toolName, event.input);
		if (isToolCallEventTypeRead(event)) {
			const raw = (event.input as { path?: unknown }).path;
			if (typeof raw === "string") {
				const skillMd = resolveSkillMdPath(raw, skillsRoot, ctx.cwd);
				if (skillMd) pendingReads.set(event.toolCallId, skillMd);
			}
		}
	});

	pi.on("tool_result", (event) => {
		if (event.type !== "tool_result") return;
		const pending = pendingReads.get(event.toolCallId);
		pendingReads.delete(event.toolCallId);
		if (pending && !event.isError) {
			// Usage counts a skill once per session — re-reads add no evidence.
			if (layerEnabled && !seen.has(pending)) {
				recordUse(usageFile, basename(dirname(pending)), Date.now());
			}
			seen.mark(pending);
		}
		const nudge = layerEnabled ? tracker.onToolResult(event.isError) : null;
		if (nudge) {
			return { content: [...event.content, { type: "text", text: nudge }] };
		}
	});

	// ONE handler: tier-1 catalog + rules block + tier-2 hint, single return.
	pi.on("before_agent_start", (event, ctx) => {
		if (!layerEnabled) return undefined; // kill-switch: passthrough native
		let systemPrompt = event.systemPrompt;
		if (settings.skills.index !== "native") {
			if (catalog === undefined) {
				const usage = loadUsage(usageFile, Date.now());
				if (usage.warning) {
					ctx.ui.notify(
						`pi-utils skill-write: skill usage file ignored — ${usage.warning}`,
						"warning",
					);
				}
				const result = transformSkillsIndex(systemPrompt, {
					skillsRoot,
					knownRoots: scanRoots(skillsRoot, ctx.cwd),
					cwd: ctx.cwd,
					hostPlatform: process.platform,
					requiresCheck,
					metaCache,
					coreLimit: settings.skills.coreLimit,
					usage: usage.scores,
				});
				catalog = result && { block: result.block, visible: result.visible };
			}
			// Parse miss (null) → passthrough the native block unchanged.
			if (catalog)
				systemPrompt = replaceSkillsBlock(systemPrompt, catalog.block);
		}

		let message:
			| { customType: string; content: string; display: boolean }
			| undefined;
		if (settings.skills.hint && catalog) {
			hintIndex ??= buildHintIndex(catalog.visible);
			const exclude = new Set(hinted);
			for (const path of seen.paths()) exclude.add(basename(dirname(path)));
			const hits = rankHints(
				hintIndex,
				buildQuery(event.prompt, activity.tokens(ctx.cwd)),
				exclude,
			);
			if (hits.length > 0) {
				for (const hit of hits) hinted.add(hit.name);
				message = {
					customType: "skill-hint",
					content: formatHint(hits),
					display: false,
				};
			}
		}
		return {
			systemPrompt: systemPrompt + RULES_BLOCK,
			...(message ? { message } : {}),
		};
	});

	function registerTool(droid: DroidRenderers | null): void {
		const disabled = new Set(settings.disabledTools);
		if (disabled.has("skill_write")) return;
		pi.registerTool({
			name: "skill_write",
			label: "skill_write",
			description:
				"Write side of the skills loop: create a new skill (SKILL.md), patch an existing one (old_string → new_string), delete one, or move it to another category — under ~/.pi/agent/skills/<category>/. Pick the category by the context the skill is used in. Single op per call, snapshot rollback on failure. patch/delete/move find the skill by name and require reading its SKILL.md with read() first.",
			promptSnippet:
				"Create/patch/delete/move learned-procedure skills under ~/.pi/agent/skills/ (read-before-write guarded)",
			promptGuidelines: [
				'Create needs the full SKILL.md text (frontmatter with name + "Use when …" description, then rules with why).',
				"Patch/delete/move require a prior read() of that SKILL.md this session — quotes from bash cat do not count.",
				"After a hard task or a user correction, save the lesson as a skill with a class-level name.",
			],
			parameters: Type.Object({
				name: Type.String({
					description: "Skill name — the directory name, ^[a-z0-9][a-z0-9_-]*$",
				}),
				action: Type.Union(
					[
						Type.Literal("create"),
						Type.Literal("patch"),
						Type.Literal("delete"),
						Type.Literal("move"),
					],
					{ description: "One operation per call" },
				),
				category: Type.Optional(
					Type.String({
						description:
							"Category dir under the skills root. Required for create/move (an existing one, or a new one with new_category:true); optional for patch/delete (skill is found by name)",
					}),
				),
				new_category: Type.Optional(
					Type.Boolean({
						description:
							"Allow category to be a new directory (create/move, default false)",
					}),
				),
				content: Type.Optional(
					Type.String({
						description:
							'Full SKILL.md text (create): "---" frontmatter (name, description "Use when …"), then rules with why',
					}),
				),
				old_string: Type.Optional(
					Type.String({
						description:
							"Text to replace (patch) — must be unique unless replace_all",
					}),
				),
				new_string: Type.Optional(
					Type.String({ description: "Replacement text (patch)" }),
				),
				replace_all: Type.Optional(
					Type.Boolean({
						description:
							"Replace every occurrence of old_string (patch, default false)",
					}),
				),
			}),
			...droidToolRender(droid, skillWriteRenderers),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runOp(params, ctx.cwd);
			},
		});
	}

	function runOp(
		params: Record<string, unknown>,
		cwd: string,
	): {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	} {
		const action = params.action;
		const name = typeof params.name === "string" ? params.name : "";
		const category =
			typeof params.category === "string" ? params.category : undefined;

		const fail = (error: string, details?: Record<string, unknown>) => ({
			content: [{ type: "text" as const, text: error }],
			details: { action, name, ...details },
			isError: true,
		});

		if (!name) return fail("name is required");
		const targetError = validateTarget({ name, category });
		if (targetError) return fail(targetError);

		if (action === "create") {
			const content = params.content;
			if (typeof content !== "string" || content.length === 0) {
				return fail(
					"create needs content — the full SKILL.md text (frontmatter with name + description, then rules)",
				);
			}
			const result = createSkill(
				{
					skillsRoot,
					name,
					category,
					newCategory: params.new_category === true,
				},
				content,
			);
			if (!result.ok)
				return fail(result.error, { rolledBack: result.rolledBack });
			return {
				content: [
					{
						type: "text",
						text: buildCreateText(result.path, content, skillsRoot, cwd),
					},
				],
				details: { action, name, path: result.path, warnings: result.warnings },
			};
		}

		if (action !== "patch" && action !== "delete" && action !== "move") {
			return fail(
				`unknown action ${String(action)} — use create | patch | delete | move`,
			);
		}
		// move's `category` is the destination — locate by name alone.
		const located = locateSkill(
			skillsRoot,
			name,
			action === "move" ? undefined : category,
		);
		if (!located.ok) return fail(located.error);
		const { dir, skillMd } = located;
		// Read-before-write guard: existing skills must be read this session.
		if (!seen.has(resolve(skillMd))) {
			return fail(
				`Read the skill first: read(${skillMd}) — writes must be based on current content.`,
				{ guard: "read-before-write" },
			);
		}

		if (action === "patch") {
			const oldString = params.old_string;
			const newString = params.new_string;
			if (typeof oldString !== "string" || typeof newString !== "string") {
				return fail("patch needs old_string + new_string");
			}
			const replaceAll = params.replace_all === true;
			const result = patchSkill(skillMd, oldString, newString, replaceAll);
			if (!result.ok)
				return fail(result.error, { rolledBack: result.rolledBack });
			const diff = cap(formatDiffs(diffHunks(oldString, newString)));
			return {
				content: [
					{
						type: "text",
						text: `skill patched: ${result.path} — ${result.extra?.join(", ") ?? "done"}${result.warnings.length > 0 ? `\n${result.warnings.join("\n")}` : ""}\n${diff}`,
					},
				],
				details: { action, name, path: result.path, warnings: result.warnings },
			};
		}

		if (action === "delete") {
			const result = deleteSkill(dir);
			if (!result.ok)
				return fail(result.error, { rolledBack: result.rolledBack });
			return {
				content: [{ type: "text", text: `skill deleted: ${result.path}` }],
				details: { action, name, path: result.path },
			};
		}

		const result = moveSkill(located, {
			skillsRoot,
			name,
			category,
			newCategory: params.new_category === true,
		});
		if (!result.ok)
			return fail(result.error, { rolledBack: result.rolledBack });
		seen.rename(resolve(skillMd), resolve(result.path));
		return {
			content: [
				{ type: "text", text: `skill moved: ${skillMd} → ${result.path}` },
			],
			details: { action, name, path: result.path },
		};
	}

	// Initial settings load + eager registration (session_start reloads:
	// droid renderers, session-scoped state, fresh settings).
	settings = loadSettings(getAgentDir()).settings;
	layerEnabled = !settings.disabledTools.includes("skill_write");
	registerTool(null);
}

/**
 * create response: path + advisory warnings + rendered index preview + tip.
 * The preview renders in the CURRENT emit format (spec e9150d8): group
 * header `# <root>` + name/description line, `location=` only on a
 * same-name collision across roots — the preview must never lie.
 */
function buildCreateText(
	path: string,
	content: string,
	skillsRoot: string,
	cwd: string,
): string {
	const lines = [`skill created: ${path}`];
	const parsed = parseSkillFile(content);
	if (parsed.ok) {
		const description =
			typeof parsed.frontmatter.description === "string"
				? parsed.frontmatter.description
				: "";
		if (description.length > DESCRIPTION_SOFT_LIMIT) {
			lines.push(
				`warning: description is ${description.length} chars — the native index renders it in full (prompt bloat). Consider ≤${DESCRIPTION_SOFT_LIMIT}.`,
			);
			const name =
				typeof parsed.frontmatter.name === "string"
					? parsed.frontmatter.name
					: "";
			const root = rootOf(path, scanRoots(skillsRoot, cwd));
			const collision = scanRoots(skillsRoot, cwd).some(
				(root2) => root2 !== root && existsSync(join(root2, name, SKILL_MD)),
			);
			const locationAttr = collision ? ` location="${path}"` : "";
			lines.push("Rendered index line (index_preview):");
			lines.push(`# ${root}`);
			lines.push(
				`  <skill name="${name}"${locationAttr}>${description}</skill>`,
			);
		}
		const recommended = ["platforms", "requires", "tags", "related"];
		const present = recommended.some((key) => key in parsed.frontmatter);
		if (!present) {
			lines.push(
				"tip: add platforms/requires/dirs/tags/related frontmatter — the smart index uses them for visibility filtering.",
			);
		}
	}
	return lines.join("\n");
}

/**
 * Candidate skills scan roots (user + project) — same list the transform
 * groups entries by. Extension-contributed dirs fall back to rootOf's
 * nearest-"skills"-ancestor heuristic.
 */
function scanRoots(skillsRoot: string, cwd: string): string[] {
	return [...new Set([skillsRoot, join(cwd, ".pi", "skills")])];
}

/** Keep the patch diff surface small (same rationale as edit.ts). */
const DIFF_MAX_LINES = 200;
function cap(rendered: string): string {
	const lines = rendered.split("\n");
	return lines.length > DIFF_MAX_LINES
		? `${lines.slice(0, DIFF_MAX_LINES).join("\n")}\n[diff truncated]`
		: rendered;
}

/** Narrow read tool_call events without importing pi internals below ext layer. */
function isToolCallEventTypeRead(event: {
	type: string;
	toolName: string;
}): boolean {
	return event.toolName === "read";
}
