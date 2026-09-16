/**
 * pi-utils / skill-write — the write half of the self-improving skill loop
 * (US-004).
 *
 * Registers `skill_write` (create/patch/delete on SKILL.md under the native
 * skills root, single-op, snapshot rollback per the US-003 discipline) and
 * ONE before_agent_start handler that (a) re-renders native's
 * <available_skills> block through the smart-index visibility pipeline
 * (config skills.index: smart | native) and (b) appends the prompt rules
 * block. Read-before-write guard + smart-index "recently-used" share one
 * session seen-map keyed on read-tool calls (bash cat never counts).
 *
 * Discovery/injection stay native — we never rescan; we only transform the
 * block pi already rendered, and pass through untouched on any parse miss.
 *
 * Settings: ~/.pi/agent/pi-utils.json ("skills" section; "skill_write" in
 * KNOWN_TOOLS for disabledTools). No pi imports below the extension layer.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
	rootOf,
	type SkillMeta,
	transformSkillsIndex,
} from "../src/skills/index-transform.ts";
import { createNudgeTracker } from "../src/skills/nudge.ts";
import {
	createSkill,
	deleteSkill,
	patchSkill,
	resolveSkillMdPath,
	SKILL_MD,
	skillDir,
} from "../src/skills/write.ts";

const RULES_BLOCK = `
## Skills
Skills under ~/.pi/agent/skills/ are your learned procedures — scan
<available_skills> and load any relevant one with read() before
starting. If a skill is wrong or missing steps, patch it with
skill_write before finishing. After a hard task or a user
correction, save the lesson as a skill: class-level name (never
"fix-X-today"), description = "Use when <trigger>", rules with
why — not a session log.
`;

export default function skillWriteExtension(pi: ExtensionAPI) {
	let settings: PiUtilsSettings = DEFAULT_SETTINGS;
	let seen: SeenMap = createSeenMap();
	let metaCache = new Map<string, SkillMeta | null>();
	let pendingReads = new Map<string, string>(); // toolCallId → resolved SKILL.md
	let tracker = createNudgeTracker(DEFAULT_SETTINGS.skills.nudgeInterval);
	const skillsRoot = join(getAgentDir(), "skills");
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
		const droid = await loadDroidRenderers();
		registerTool(droid);
	});

	// Read tracking: resolve the read input; mark seen only on a successful
	// result (tool_call fires before execution, tool_result after).
	pi.on("tool_call", (event, ctx) => {
		if (event.type !== "tool_call") return;
		const isSkillWrite = event.toolName === "skill_write";
		tracker.onToolCall(isSkillWrite);
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
		if (pending && !event.isError) seen.mark(pending);
		const nudge = layerEnabled ? tracker.onToolResult(event.isError) : null;
		if (nudge) {
			return { content: [...event.content, { type: "text", text: nudge }] };
		}
	});

	// ONE handler: smart-index transform + rules-block append, single return.
	pi.on("before_agent_start", (event, ctx) => {
		if (!layerEnabled) return undefined; // kill-switch: passthrough native
		let systemPrompt = event.systemPrompt;
		if (settings.skills.index !== "native") {
			const result = transformSkillsIndex(
				systemPrompt,
				settings.skills.indexFullLimit,
				seen.paths(),
				{
					skillsRoot,
					knownRoots: scanRoots(skillsRoot, ctx.cwd),
					hostPlatform: process.platform,
					requiresCheck,
					metaCache,
				},
			);
			if (result) {
				systemPrompt =
					systemPrompt.slice(0, result.start) +
					result.block +
					systemPrompt.slice(result.end);
			}
			// Parse miss → passthrough the native block unchanged.
		}
		return { systemPrompt: systemPrompt + RULES_BLOCK };
	});

	function registerTool(droid: DroidRenderers | null): void {
		const disabled = new Set(settings.disabledTools);
		if (disabled.has("skill_write")) return;
		pi.registerTool({
			name: "skill_write",
			label: "skill_write",
			description:
				"Write side of the skills loop: create a new skill (SKILL.md), patch an existing one (old_string → new_string), or delete one — under ~/.pi/agent/skills/. Single op per call, snapshot rollback on failure. patch/delete require reading the skill's SKILL.md with read() first.",
			promptSnippet:
				"Create/patch/delete learned-procedure skills under ~/.pi/agent/skills/ (read-before-write guarded)",
			promptGuidelines: [
				'Create needs the full SKILL.md text (frontmatter with name + "Use when …" description, then rules with why).',
				"Patch/delete require a prior read() of that SKILL.md this session — quotes from bash cat do not count.",
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
					],
					{ description: "One operation per call" },
				),
				category: Type.Optional(
					Type.String({
						description:
							"Optional single subdirectory under the skills root (create)",
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
		const dir = skillDir({ skillsRoot, name, category });
		const skillMd = join(dir, SKILL_MD);

		if (action === "create") {
			const content = params.content;
			if (typeof content !== "string" || content.length === 0) {
				return fail(
					"create needs content — the full SKILL.md text (frontmatter with name + description, then rules)",
				);
			}
			const result = createSkill({ skillsRoot, name, category }, content);
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

		if (action === "patch") {
			const oldString = params.old_string;
			const newString = params.new_string;
			if (typeof oldString !== "string" || typeof newString !== "string") {
				return fail("patch needs old_string + new_string");
			}
			if (!existsSync(skillMd)) {
				return fail(`no skill at ${dir} — create it with action:"create"`);
			}
			// Read-before-write guard: existing skills must be read this session.
			if (!seen.has(resolve(skillMd))) {
				return fail(
					`Read the skill first: read(${skillMd}) — writes must be based on current content.`,
					{ guard: "read-before-write" },
				);
			}
			const replaceAll = params.replace_all === true;
			const result = patchSkill(skillMd, oldString, newString, replaceAll);
			if (!result.ok)
				return fail(result.error, { rolledBack: result.rolledBack });
			const before = oldString;
			const after = newString;
			const diff = cap(formatDiffs(diffHunks(before, after)));
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
			if (!existsSync(skillMd)) {
				return fail(`no skill at ${dir} — nothing to delete`);
			}
			if (!seen.has(resolve(skillMd))) {
				return fail(
					`Read the skill first: read(${skillMd}) — writes must be based on current content.`,
					{ guard: "read-before-write" },
				);
			}
			const result = deleteSkill(dir);
			if (!result.ok)
				return fail(result.error, { rolledBack: result.rolledBack });
			return {
				content: [{ type: "text", text: `skill deleted: ${result.path}` }],
				details: { action, name, path: result.path },
			};
		}

		return fail(
			`unknown action ${String(action)} — use create | patch | delete`,
		);
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
				"tip: add platforms/requires/tags/related frontmatter — the smart index uses them for visibility filtering.",
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
