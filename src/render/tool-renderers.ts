/**
 * Thin per-tool renderCall/renderResult builders on top of droid-styling
 * primitives (see droid.ts). Each builder mirrors the visual grammar of
 * droid-styling's own tool tags: compact boxed call with a badge title, a
 * one-line dim footer while collapsed, and a boxed body when expanded.
 */
import type { ComponentLike, DroidRenderers } from "./droid.ts";
import { resultText } from "./droid.ts";

/** Attach droid-styling renderers to a tool definition when available. */
export function droidToolRender(
	droid: DroidRenderers | null,
	build: (d: DroidRenderers) => {
		renderCall: (...a: never[]) => unknown;
		renderResult: (...a: never[]) => unknown;
	},
): { renderCall?: never; renderResult?: never } {
	if (!droid) return {};
	const built = build(droid);
	return {
		renderCall: built.renderCall as never,
		renderResult: built.renderResult as never,
	};
}

export interface RenderContext {
	theme: unknown;
	state?: unknown;
	isError?: boolean;
	isPartial?: boolean;
	args?: Record<string, unknown>;
}

export interface RenderResultContext extends RenderContext {
	options: unknown;
	result: {
		content?: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
}

const DEFAULT_PREVIEW_LINES = 20;

function clip(text: string, max = 120): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Compact boxed call: `Badge  detail` in one box row. */
export function compactCall(
	droid: DroidRenderers,
	title: string,
	detail: string,
	context: RenderContext,
): ComponentLike {
	return droid.renderCompactBoxedToolCall(context.theme, title, clip(detail), {
		widthKey: droid.boxedToolWidthKey(title, detail),
		state: context.state,
		isError: context.isError,
		isPartial: context.isPartial,
		isPending: context.isPartial,
	});
}

/**
 * Standard result: collapsed → compact one-line footer; expanded → boxed body
 * (dim tool output, red on error) with the footer line.
 */
export function boxedResult(
	droid: DroidRenderers,
	title: string,
	detail: string,
	context: RenderResultContext,
	maxPreviewLines = DEFAULT_PREVIEW_LINES,
	extraParts: string[] = [],
): ComponentLike {
	droid.clearCompactBoxedFooter(context.state);
	const text = resultText(context.result).trimEnd();
	const isError = Boolean(context.result.isError);
	const widthKey = droid.boxedToolWidthKey(title, detail);

	if (!droid.isExpanded(context.options)) {
		return droid.renderCompactBoxedFooter(context.theme, context.result, {
			state: context.state,
			isError,
			isPartial: Boolean(context.isPartial),
		});
	}

	return droid.renderBoxedToolResult(
		context.theme,
		(width: number) => {
			const body = droid.renderLines(context.theme, text, context.options, {
				maxLines: maxPreviewLines,
				color: isError ? "error" : "toolOutput",
				width,
			});
			return body ? body.split("\n") : [];
		},
		{
			widthKey,
			referenceLines: [`${title}: ${clip(detail)}`],
			footerLines: [
				droid.formatBoxedFooter(context.theme, context.result, extraParts),
			],
		},
	);
}

/** grep result: count `path:line:` rows for the "Found N matches." summary. */
export function grepMatchCount(text: string): number {
	if (!text || text === "No matches found.") return 0;
	return text.split("\n").filter((line) => /:\d+:/.test(line)).length;
}

// ── fs-search ───────────────────────────────────────────────────────────────

export function grepRenderers(droid: DroidRenderers) {
	const detail = (args: Record<string, unknown> | undefined): string => {
		const pattern = String(args?.pattern ?? "");
		const rawPath = String(args?.path ?? ".");
		const displayPath =
			rawPath === "." || rawPath === "" ? "current directory" : rawPath;
		return pattern ? `/${pattern}/ in ${displayPath}` : displayPath;
	};
	return {
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: unknown,
			context: RenderContext,
		) {
			return compactCall(droid, "Search", detail(args), {
				...context,
				theme,
				args,
			});
		},
		renderResult(
			result: RenderResultContext["result"],
			options: unknown,
			theme: unknown,
			context: RenderContext,
		) {
			droid.clearCompactBoxedFooter(context.state);
			const text = resultText(result).trimEnd();
			const d = detail(context.args);
			const isError = Boolean(result.isError);
			const count = grepMatchCount(text);
			const summary = `↳ Found ${count} ${count === 1 ? "match" : "matches"}.`;

			if (!droid.isExpanded(options)) {
				return droid.renderCompactBoxedFooter(theme, result, {
					state: context.state,
					isError,
					isPartial: Boolean(context.isPartial),
				});
			}
			return droid.renderBoxedToolResult(
				theme,
				(width: number) => {
					const body =
						count === 0
							? ""
							: droid.renderLines(theme, text, options, {
									maxLines: DEFAULT_PREVIEW_LINES,
									color: isError ? "error" : "toolOutput",
									width,
								});
					return [summary, ...(body ? body.split("\n") : [])];
				},
				{
					widthKey: droid.boxedToolWidthKey("Search", d),
					referenceLines: [`Query: ${d}`],
					footerLines: [droid.formatBoxedFooter(theme, result)],
				},
			);
		},
	};
}

export function globRenderers(droid: DroidRenderers) {
	return {
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: unknown,
			context: RenderContext,
		) {
			const pattern = String(args?.pattern ?? "");
			const rawPath = String(args?.path ?? ".");
			const displayPath =
				rawPath === "." || rawPath === "" ? "" : ` in ${rawPath}`;
			return compactCall(droid, "Glob", `${pattern}${displayPath}`, {
				...context,
				theme,
				args,
			});
		},
		renderResult(
			result: RenderResultContext["result"],
			options: unknown,
			theme: unknown,
			context: RenderContext,
		) {
			return boxedResult(droid, "Glob", String(context.args?.pattern ?? ""), {
				result,
				options,
				theme,
				state: context.state,
				isError: context.isError,
				isPartial: context.isPartial,
				args: context.args,
			});
		},
	};
}

// ── shell-bg ────────────────────────────────────────────────────────────────

export function bashRenderers(droid: DroidRenderers) {
	return {
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: unknown,
			context: RenderContext,
		) {
			const command = String(args?.command ?? "...");
			const flags = [
				args?.background === true ? "bg" : undefined,
				args?.timeout !== undefined ? `${args?.timeout}s` : undefined,
			]
				.filter(Boolean)
				.join(" ");
			const detail = `${command.split("\n")[0] ?? ""}${flags ? `  (${flags})` : ""}`;
			return compactCall(droid, "Bash", detail, { ...context, theme, args });
		},
		renderResult(
			result: RenderResultContext["result"],
			options: unknown,
			theme: unknown,
			context: RenderContext,
		) {
			const flags = [
				context.args?.background === true ? "bg" : undefined,
				context.args?.timeout !== undefined
					? `timeout:${String(context.args.timeout)}s`
					: undefined,
			].filter((part): part is string => part !== undefined);
			return boxedResult(
				droid,
				"Bash",
				String(context.args?.command ?? ""),
				{
					result,
					options,
					theme,
					state: context.state,
					isError: context.isError,
					isPartial: context.isPartial,
					args: context.args,
				},
				DEFAULT_PREVIEW_LINES,
				flags,
			);
		},
	};
}

export function simpleRenderers(title: string) {
	return (droid: DroidRenderers) => ({
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: unknown,
			context: RenderContext,
		) {
			const id = args?.id !== undefined ? ` ${String(args.id)}` : "";
			return compactCall(droid, title, id.trim() || "all jobs", {
				...context,
				theme,
				args,
			});
		},
		renderResult(
			result: RenderResultContext["result"],
			options: unknown,
			theme: unknown,
			context: RenderContext,
		) {
			return boxedResult(droid, title, String(context.args?.id ?? "all"), {
				result,
				options,
				theme,
				state: context.state,
				isError: context.isError,
				isPartial: context.isPartial,
				args: context.args,
			});
		},
	});
}

// ── edit ────────────────────────────────────────────────────────────

/** Script-mode edit: compact call shows the declared paths. */
export function editRenderers(droid: DroidRenderers) {
	const detail = (args: Record<string, unknown> | undefined): string => {
		const paths = Array.isArray(args?.paths) ? args.paths : [];
		const lang = String(args?.lang ?? "");
		const shown = paths.length > 2 ? `${paths.length} paths` : paths.join(", ");
		return lang ? `${shown} (${lang})` : shown;
	};
	return {
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: unknown,
			context: RenderContext,
		) {
			return compactCall(droid, "Edit", detail(args), {
				...context,
				theme,
				args,
			});
		},
		renderResult(
			result: RenderResultContext["result"],
			options: unknown,
			theme: unknown,
			context: RenderContext,
		) {
			return boxedResult(droid, "Edit", detail(context.args), {
				result,
				options,
				theme,
				state: context.state,
				isError: context.isError,
				isPartial: context.isPartial,
				args: context.args,
			});
		},
	};
}

/** skill_write (US-004): compact box, detail = "action name/category". */
export function skillWriteRenderers(droid: DroidRenderers) {
	const detail = (args: Record<string, unknown> | undefined): string => {
		const action = String(args?.action ?? "");
		const name = String(args?.name ?? "");
		const category = args?.category ? `${args.category}/` : "";
		return `${action} ${category}${name}`.trim();
	};
	return {
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: unknown,
			context: RenderContext,
		) {
			return compactCall(droid, "Skill", detail(args), {
				...context,
				theme,
				args,
			});
		},
		renderResult(
			result: RenderResultContext["result"],
			options: unknown,
			theme: unknown,
			context: RenderContext,
		) {
			return boxedResult(droid, "Skill", detail(context.args), {
				result,
				options,
				theme,
				state: context.state,
				isError: context.isError,
				isPartial: context.isPartial,
				args: context.args,
			});
		},
	};
}
