/**
 * Optional @sting8k/pi-droid-styling adaptation — borrow primitives, never port.
 *
 * pi-utils does NOT hard-depend on droid-styling (it re-registers rendering for
 * other tools; forcing it on every pi-utils user would restyle their UI). At
 * session_start we try to import its renderer primitives; present → our tools
 * re-register with droid-styled renderCall/renderResult; absent → pi's default
 * rendering stays. Resolution per install mode:
 *
 * - dev here:            devDependencies "file:../pi-droid-styling" (symlink)
 * - pi install npm: both: flat ~/.pi/agent/npm/node_modules sibling resolution
 * - anything else:        import fails → graceful fallback
 *
 * The specifier is overridable (PI_UTILS_DROID_MODULE) so tests can point at a
 * stub. Pure module: no pi imports; Component is a local structural type.
 */

export interface ComponentLike {
	invalidate(): void;
	render(width: number): string[];
}

export interface DroidRenderers {
	renderCompactBoxedToolCall: (
		theme: unknown,
		toolName: string,
		detailLine: string,
		options: {
			widthKey?: string;
			state?: unknown;
			isError?: boolean;
			isPartial?: boolean;
			isPending?: boolean;
			pendingText?: string;
		},
	) => ComponentLike;
	renderBoxedToolResult: (
		theme: unknown,
		body: ComponentLike | ((contentWidth: number) => string[]),
		options: {
			widthKey?: string;
			referenceLines?: string[];
			footerLines?: string[];
			isError?: boolean;
		},
	) => ComponentLike;
	renderCompactBoxedFooter: (
		theme: unknown,
		result: unknown,
		options: { state?: unknown; isError?: boolean; isPartial?: boolean },
	) => ComponentLike;
	clearCompactBoxedFooter: (state: unknown) => void;
	boxedToolWidthKey: (toolName: string, detail: string) => string;
	formatBoxedFooter: (
		theme: unknown,
		result: unknown,
		extraParts?: string[],
	) => string;
	renderLines: (
		theme: unknown,
		text: string,
		options: unknown,
		opts: { maxLines?: number; color?: string; width?: number },
	) => string;
	isExpanded: (options: unknown) => boolean;
}

/** Result text of our tools: first content block's text. */
export function resultText(result: unknown): string {
	const content = (result as { content?: Array<{ text?: string }> } | undefined)
		?.content;
	const first = content?.[0];
	return typeof first?.text === "string" ? first.text : "";
}

/**
 * Wrap an execute body with wall-time timing, stored where droid-styling's
 * footer reads it (result.details.__elapsedMs — same key as its own
 * wrapExecuteWithTiming). This is what makes the ◷ X.XXs metric appear in
 * both collapsed and expanded footers.
 */
export async function withTiming<
	T extends { details?: Record<string, unknown> },
>(fn: () => Promise<T>): Promise<T> {
	const startedAt = Date.now();
	const result = await fn();
	const details = (result.details ?? {}) as Record<string, unknown>;
	details.__elapsedMs = Date.now() - startedAt;
	result.details = details;
	return result;
}

const DEFAULT_SPECIFIER = "@sting8k/pi-droid-styling/tool-tags/common.js";

let cached: DroidRenderers | null | undefined;
let specifier: string | undefined;

/** Test hook: reset cache (and optionally pin a specifier). */
export function resetDroidRenderersForTests(nextSpecifier?: string): void {
	cached = undefined;
	specifier = nextSpecifier;
}

function pick(mod: Record<string, unknown>): DroidRenderers | null {
	const required = [
		"renderCompactBoxedToolCall",
		"renderBoxedToolResult",
		"renderCompactBoxedFooter",
		"clearCompactBoxedFooter",
		"boxedToolWidthKey",
		"formatBoxedFooter",
		"renderLines",
		"isExpanded",
	] as const;
	for (const name of required) {
		if (typeof mod[name] !== "function") return null;
	}
	return mod as unknown as DroidRenderers;
}

export async function loadDroidRenderers(): Promise<DroidRenderers | null> {
	if (cached !== undefined) return cached;
	const target =
		specifier ?? process.env.PI_UTILS_DROID_MODULE ?? DEFAULT_SPECIFIER;
	try {
		const mod = (await import(target)) as Record<string, unknown>;
		cached = pick(mod);
	} catch {
		// Absent, unresolvable, or incompatible — fall back to default rendering.
		cached = null;
	}
	return cached;
}
