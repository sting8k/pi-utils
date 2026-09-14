/**
 * pi-utils / shell-bg — long-running bash goes async.
 *
 * Re-registers pi's `bash` tool with the same shell, cwd and env (via
 * getShellConfig), but a different lifecycle:
 *
 *   - output streams to a per-job log file (piped + written by us — the
 *     inherited-fd trick is not portable to Windows); the process is spawned
 *     detached and unref'd so it survives the tool returning;
 *   - a foreground command still running after autoBackgroundMs (interactive
 *     sessions only) is moved to the background: the tool returns
 *     "moved to background, id=…" and the result is delivered into the
 *     conversation when the command finishes;
 *   - `background: true` launches detached from the start and returns the id
 *     immediately; `timeout: N` (seconds) kills the whole process tree;
 *   - standalone pure searches (`rg` / `grep` / `find` with no pipes, chains
 *     or substitution) route to the fs-search cores (US-001): caps, spill
 *     files, formatted rows — anything else runs in bash unchanged.
 *
 * `shell_status` polls or collects a job (and lists them all); `shell_kill`
 * terminates one and its whole tree. `/shell-bg` lists jobs, `/shell-bg kill
 * <id>` stops one; a widget above the editor shows running jobs. Delivery
 * only works in sessions that outlive the run, so auto-background is off
 * under headless `pi -p` (explicit background still works, collected with
 * shell_status inside the turn).
 *
 * Design credit: pifydev/shell-background (MIT) — self-implemented per
 * decision 0008 / D4. Settings come from ~/.pi/agent/pi-utils.json.
 */

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveRg } from "../src/common/rg-resolver.ts";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	type PiUtilsSettings,
} from "../src/common/settings.ts";
import {
	matchBashSearch,
	type RoutedSearch,
} from "../src/fs-search/bash-router.ts";
import { runGlob } from "../src/fs-search/glob-core.ts";
import { runGrep } from "../src/fs-search/grep-core.ts";
import {
	type DroidRenderers,
	loadDroidRenderers,
	withTiming,
} from "../src/render/droid.ts";
import {
	bashRenderers,
	droidToolRender,
	simpleRenderers,
} from "../src/render/tool-renderers.ts";
import {
	formatList,
	formatResult,
	formatSnapshot,
	type WidgetModel,
	type WidgetRow,
	widgetModel,
} from "../src/shell-bg/format.ts";
import { killTree } from "../src/shell-bg/kill.ts";
import {
	backgroundedResult,
	DELIVERY_TYPE,
	deliveryMessage,
} from "../src/shell-bg/pending.ts";
import { JobRegistry } from "../src/shell-bg/registry.ts";
import { type Spawned, spawnToFile } from "../src/shell-bg/spawn.ts";
import type { Job } from "../src/shell-bg/types.ts";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

interface BashParams {
	command: string;
	timeout?: number;
	background?: boolean;
}

const WIDGET = "shell-bg";

export default function shellBackground(pi: ExtensionAPI) {
	let settings: PiUtilsSettings = DEFAULT_SETTINGS;
	let registry: JobRegistry | null = null;
	let lastUiCtx: ExtensionContext | null = null;
	let widgetTimer: ReturnType<typeof setInterval> | null = null;

	function sessionKey(cwd: string): string {
		const id = process.env.PI_SESSION_ID;
		if (id) return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
		return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	}

	let rgPath: string | null = null;

	/** Lazy rg resolution, same pattern as the fs-search extension. */
	function rg(): string {
		if (rgPath === null) rgPath = resolveRg(getAgentDir());
		return rgPath;
	}

	/** Shell + args, reusing pi's resolution; command rides in argv (not stdin). */
	function shellArgv(): { shell: string; args: string[] } {
		const cfg = getShellConfig();
		// Our stdio ignores stdin, so a stdin command transport cannot receive the
		// command — fall back to -c, which every shell accepts.
		const args = cfg.commandTransport === "stdin" ? ["-c"] : [...cfg.args];
		return { shell: cfg.shell, args };
	}

	/** Structural slice of pi's Theme — only what the widget paints with. */
	type WidgetTheme = {
		fg(color: string, text: string): string;
		bold(text: string): string;
	};

	/** Row budget per droid-styling's reasonix rows: 80% of width (full width
	 * only under 40 cols) — rows stay airy, off the terminal edge. */
	const ROW_MIN_WIDTH = 40;
	const ROW_WIDTH_RATIO = 0.8;

	function rowWidth(width: number): number {
		const available = Math.max(1, Math.floor(width));
		return available <= ROW_MIN_WIDTH
			? available
			: Math.floor(available * ROW_WIDTH_RATIO);
	}

	/** Paint the model: mirrors a transcript tool row — small marker at col 0,
	 * "Jobs" lands on col 2 where tool names render (reasonix "✓ ToolName …") —
	 * with branch rows one level deeper. Clipping follows droid's row mechanism:
	 * meta (right part) is measured first and never clipped; the command gets
	 * what remains, truncated display-width aware and padded to its budget so
	 * meta lands on the same column in every row. */
	function paintWidget(
		model: WidgetModel,
		theme: WidgetTheme,
		width: number,
	): string[] {
		const lines = [
			`${theme.fg("accent", "•")} ${theme.fg("accent", theme.bold("Jobs"))}${theme.fg("dim", ` · ${model.running} running`)}`,
		];
		const rows: Array<WidgetRow | null> = [...model.rows];
		if (model.hidden > 0) rows.push(null); // sentinel: the ⋯ row is a row too
		for (const [index, row] of rows.entries()) {
			const isLast = index === rows.length - 1;
			const branch = theme.fg("dim", isLast ? "└─ " : "├─ ");
			if (!row) {
				lines.push(
					`    ${branch}${theme.fg("dim", `⋯ and ${model.hidden} more`)}`,
				);
				continue;
			}
			const id = theme.fg("dim", row.id.padEnd(6));
			// Droid's split: meta (right) measured first and never clipped; the
			// command gets what remains of the row budget, truncated display-width
			// aware (dim ellipsis) and padded to that budget so meta aligns on the
			// same column in every row. Prefix = indent + branch + id + space.
			const meta = `· ${row.elapsedText}${row.auto ? " (auto)" : ""}`;
			const metaWidth = visibleWidth(meta);
			const budget = Math.max(12, rowWidth(width) - 14 - metaWidth);
			const normalized = row.command.replace(/[\t\n\v\f\r]+/g, " ").trim();
			const cmd = truncateToWidth(normalized, budget, theme.fg("dim", " …"));
			const pad = " ".repeat(Math.max(0, budget - visibleWidth(cmd)));
			lines.push(`    ${branch}${id} ${cmd}${pad} ${theme.fg("dim", meta)}`);
		}
		return lines;
	}

	function stopWidgetTick(): void {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = null;
		}
	}

	function renderWidget(ctx: ExtensionContext | null = lastUiCtx): void {
		if (!ctx?.hasUI || !registry) return;
		lastUiCtx = ctx;
		const model = widgetModel(registry.all());
		if (model.running === 0) {
			ctx.ui.setWidget(WIDGET, undefined);
			stopWidgetTick();
			return;
		}
		ctx.ui.setWidget(
			WIDGET,
			(_tui, theme) => ({
				invalidate(): void {},
				render: (width: number) =>
					paintWidget(model, theme as WidgetTheme, width),
			}),
			{ placement: "aboveEditor" },
		);
		// Elapsed refreshes while jobs run; the tick stops with the last one.
		if (widgetTimer === null) {
			widgetTimer = setInterval(() => renderWidget(), 1000);
		}
	}

	function snapshot(job: Job): Promise<ToolResult> {
		return formatSnapshot(job, settings.shellBg.tailBytes).then((text) => ({
			content: [{ type: "text", text }],
			details: { id: job.id, status: job.status },
		}));
	}

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadSettings(getAgentDir());
		settings = loaded.settings;
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-utils shell-bg: ${warning}`, "warning");
		}
		registry = new JobRegistry(
			join(tmpdir(), "pi-utils-shell-bg", sessionKey(ctx.cwd)),
		);
		registry.load();
		renderWidget(ctx);
		// Adapt to @sting8k/pi-droid-styling when present (see render/droid.ts).
		const droid = await loadDroidRenderers();
		if (droid) registerTools(droid);
	});

	pi.on("session_shutdown", async () => {
		stopWidgetTick();
		if (!registry) return;
		for (const job of registry.running()) {
			job.killedByUs = true;
			killTree(job.pid, settings.shellBg.killGraceMs);
			if (job.status === "running") {
				job.status = "killed";
				job.endedAt = Date.now();
			}
			registry.persist(job);
		}
	});

	/** Deliver a finished background job into the conversation, once. */
	function scheduleDelivery(job: Job, exit: Promise<unknown>): void {
		exit
			.then(async () => {
				if (job.delivered) return;
				job.delivered = true;
				registry?.persist(job);
				renderWidget();
				pi.sendMessage(
					{
						customType: DELIVERY_TYPE,
						content: deliveryMessage(
							job.id,
							await formatResult(job, settings.shellBg.tailBytes),
						),
						display: true,
						details: { id: job.id, status: job.status, exitCode: job.exitCode },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			})
			.catch(() => {
				// A /reload can make captured handles throw; delivery is a convenience,
				// shell_status still collects the result.
			});
	}

	/**
	 * Execute a routed search on the fs-search core (US-001): one-line note
	 * prefix stating routing + superset ignore semantics + caps/spill, core
	 * counts in details. A core error is surfaced as an error result — never a
	 * silent bash fallback (the command already proved routable).
	 */
	async function routedResult(
		routed: RoutedSearch,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const note =
			`[fs-search] bash routed to ${routed.kind} semantics — hidden+` +
			"gitignored files included, caps + spill apply.";
		try {
			if (routed.kind === "grep") {
				const result = await runGrep(
					rg(),
					routed.params,
					settings.fsSearch,
					ctx.cwd,
					signal,
				);
				return {
					content: [{ type: "text", text: `${note}\n${result.text}` }],
					details: {
						routed: true,
						kind: routed.kind,
						matchCount: result.matchCount,
						fileCount: result.fileCount,
						matchLimitReached: result.matchLimitReached,
						spillPath: result.spillPath,
					},
				};
			}
			const result = await runGlob(
				rg(),
				routed.params,
				settings.fsSearch,
				ctx.cwd,
				signal,
			);
			return {
				content: [{ type: "text", text: `${note}\n${result.text}` }],
				details: {
					routed: true,
					kind: routed.kind,
					total: result.total,
					spillPath: result.spillPath,
				},
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `${note}\n${message}` }],
				details: { routed: true, kind: routed.kind },
				isError: true,
			};
		}
	}

	async function runBash(
		params: BashParams,
		signal: AbortSignal | undefined,
		onUpdate: ((result: ToolResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult> {
		lastUiCtx = ctx;
		if (!registry) throw new Error("shell-bg not initialized (no session yet)");
		const command = String(params.command ?? "").trim();
		if (command === "") {
			return {
				content: [{ type: "text", text: "Empty command." }],
				details: {},
				isError: true,
			};
		}

		// US-001: standalone pure searches execute on the fs-search cores —
		// only for plain foreground calls without a timeout, which keep no job
		// lifecycle. Anything the matcher cannot prove 1:1 falls through.
		if (!params.background && params.timeout === undefined) {
			const routed = matchBashSearch(command);
			if (routed) return routedResult(routed, ctx, signal);
		}

		const job = registry.create(command, ctx.cwd);
		const { shell, args } = shellArgv();

		let spawned: Spawned;
		try {
			spawned = spawnToFile(
				shell,
				args,
				command,
				ctx.cwd,
				process.env,
				job.logPath,
			);
		} catch (err) {
			job.status = "failed";
			job.endedAt = Date.now();
			registry.persist(job);
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Failed to start: ${message}` }],
				details: {},
				isError: true,
			};
		}
		job.pid = spawned.pid;
		registry.persist(job);
		renderWidget(ctx);

		const settle = spawned.exit.then(({ code, signal: sig }) => {
			if (job.status === "running") {
				job.status =
					job.killedByUs || sig ? "killed" : code === 0 ? "done" : "failed";
			}
			job.exitCode = code;
			job.signal = sig;
			job.endedAt = Date.now();
			registry?.persist(job);
			renderWidget();
		});

		if (params.background === true) {
			scheduleDelivery(job, settle);
			const r = backgroundedResult({
				id: job.id,
				command,
				elapsedMs: 0,
				auto: false,
				interactive: ctx.hasUI,
				collectWith: "shell_status",
			});
			return { content: [{ type: "text", text: r.text }], details: r.details };
		}

		// Foreground: race the process against the auto-background threshold, an
		// optional timeout, and the turn's abort signal — streaming the tail.
		const autoMs = ctx.hasUI ? settings.shellBg.autoBackgroundMs : 0;
		const timeoutMs =
			params.timeout !== undefined && params.timeout > 0
				? params.timeout * 1000
				: undefined;

		const timers: NodeJS.Timeout[] = [];
		const after = (ms: number, val: string) =>
			new Promise<string>((res) => {
				const t = setTimeout(() => res(val), ms);
				t.unref?.();
				timers.push(t);
			});
		const racers: Promise<string>[] = [settle.then(() => "exit")];
		if (autoMs > 0) racers.push(after(autoMs, "auto"));
		if (timeoutMs !== undefined) racers.push(after(timeoutMs, "timeout"));

		let streamTimer: NodeJS.Timeout | undefined;
		if (onUpdate) {
			streamTimer = setInterval(() => {
				void snapshot(job).then(onUpdate);
			}, 1000);
			streamTimer.unref?.();
		}

		const onAbort = () => undefined;
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const winner = await Promise.race(racers);
			if (signal?.aborted) throw new Error("Operation aborted");

			if (winner === "auto") {
				job.auto = true;
				registry.persist(job);
				renderWidget(ctx);
				scheduleDelivery(job, settle);
				const r = backgroundedResult({
					id: job.id,
					command,
					elapsedMs: Date.now() - job.startedAt,
					auto: true,
					interactive: ctx.hasUI,
					collectWith: "shell_status",
				});
				return {
					content: [{ type: "text", text: r.text }],
					details: r.details,
				};
			}

			if (winner === "timeout") {
				job.killedByUs = true;
				killTree(job.pid, settings.shellBg.killGraceMs);
				await settle;
				const body = await formatResult(job, settings.shellBg.tailBytes);
				return {
					content: [
						{
							type: "text",
							text: `Killed: exceeded ${params.timeout}s timeout.\n${body}`,
						},
					],
					details: { id: job.id, status: job.status, timedOut: true },
					isError: true,
				};
			}

			// exit — also covers the abort race losing to a fast exit.
			await settle;
			if (signal?.aborted && job.status === "running")
				throw new Error("Operation aborted");
			const body = await formatResult(job, settings.shellBg.tailBytes);
			const head = job.signal
				? `Killed (signal ${job.signal}).`
				: `exit ${job.exitCode ?? "unknown"}`;
			return {
				content: [{ type: "text", text: `${head}\n${body}` }],
				details: { id: job.id, status: job.status, exitCode: job.exitCode },
				isError: job.status === "failed" || job.status === "killed",
			};
		} finally {
			if (streamTimer !== undefined) clearInterval(streamTimer);
			for (const t of timers) clearTimeout(t);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	function registerTools(droid: DroidRenderers | null): void {
		pi.registerTool({
			name: "bash",
			label: "bash",
			description:
				"Execute a bash command (pi-utils shell-bg override: same shell, cwd, env). Foreground commands " +
				"still running after 30s auto-move to the background in interactive sessions — the tool returns " +
				"a job id and the result is delivered into the conversation when it finishes. Pass " +
				"background:true to start detached immediately; timeout:N (seconds) kills the whole process " +
				"tree. Manage jobs with shell_status / shell_kill.",
			promptSnippet:
				"Run bash; long or background:true commands return a job id (collect via shell_status)",
			promptGuidelines: [
				"Use bash normally for quick commands; for long-running ones (builds, dev servers) pass background:true and collect with shell_status.",
			],
			parameters: Type.Object({
				command: Type.String({ description: "Bash command to execute" }),
				timeout: Type.Optional(
					Type.Number({
						description:
							"Timeout in seconds — the whole process tree is killed past it",
					}),
				),
				background: Type.Optional(
					Type.Boolean({
						description:
							"Launch detached in the background; returns a job id immediately (result delivered when done; use shell_status to poll)",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return withTiming(() =>
					runBash(params, signal, onUpdate as never, ctx),
				);
			},
			...droidToolRender(droid, bashRenderers),
		});

		pi.registerTool({
			name: "shell_status",
			label: "Shell status",
			description:
				"Check a background shell job: with id, returns its status and output so far (or its final " +
				"result once finished); without id, lists every background job this session.",
			promptSnippet:
				"Poll or collect background bash jobs; no id lists them all",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({
						description: 'Job id, e.g. "bg-1" (omit to list all jobs)',
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				if (!registry)
					throw new Error("shell-bg not initialized (no session yet)");
				if (params.id === undefined) {
					return {
						content: [{ type: "text", text: formatList(registry.all()) }],
						details: {},
					};
				}
				const job = registry.get(params.id);
				if (!job) throw new Error(`Unknown background job: ${params.id}`);
				if (job.status === "running") {
					const text = await formatSnapshot(job, settings.shellBg.tailBytes);
					return {
						content: [{ type: "text", text }],
						details: { id: job.id, status: job.status },
					};
				}
				const text = await formatResult(job, settings.shellBg.tailBytes);
				return {
					content: [{ type: "text", text }],
					details: { id: job.id, status: job.status, exitCode: job.exitCode },
					isError: job.status === "failed",
				};
			},
			...droidToolRender(droid, simpleRenderers("Shell status")),
		});

		pi.registerTool({
			name: "shell_kill",
			label: "Shell kill",
			description: "Stop a background shell job and its whole process tree.",
			promptSnippet: "Kill a background bash job by id",
			parameters: Type.Object({
				id: Type.String({ description: 'Job id, e.g. "bg-1"' }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				if (!registry)
					throw new Error("shell-bg not initialized (no session yet)");
				const job = registry.get(params.id);
				if (!job) throw new Error(`Unknown background job: ${params.id}`);
				if (job.status !== "running") {
					return {
						content: [
							{ type: "text", text: `${job.id} already ${job.status}.` },
						],
						details: { id: job.id, status: job.status },
					};
				}
				job.killedByUs = true;
				killTree(job.pid, settings.shellBg.killGraceMs);
				return {
					content: [
						{ type: "text", text: `Killed ${job.id} and its process tree.` },
					],
					details: { id: job.id, status: "killed" },
				};
			},
			...droidToolRender(droid, simpleRenderers("Shell kill")),
		});
	}

	pi.registerCommand("shell-bg", {
		description: "List background shell jobs; '/shell-bg kill <id>' stops one",
		handler: async (args, ctx) => {
			if (!registry) return;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "kill" && parts[1]) {
				const job = registry.get(parts[1]);
				if (!job) {
					ctx.ui.notify(`Unknown job: ${parts[1]}`, "error");
					return;
				}
				if (job.status === "running") {
					job.killedByUs = true;
					killTree(job.pid, settings.shellBg.killGraceMs);
					ctx.ui.notify(`Killed ${job.id}`, "info");
				} else {
					ctx.ui.notify(`${job.id} already ${job.status}`, "info");
				}
				return;
			}
			ctx.ui.notify(formatList(registry.all()), "info");
		},
	});

	registerTools(null);
}
