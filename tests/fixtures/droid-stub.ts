/**
 * Minimal stand-in for @sting8k/pi-droid-styling/tool-tags/common.js — same
 * exported names and shapes as the real primitives, single-line outputs so
 * assertions are trivial. Used via resetDroidRenderersForTests(specifier).
 */

interface StubOptions {
	isError?: boolean;
}

export function renderCompactBoxedToolCall(
	_theme: unknown,
	toolName: string,
	detailLine: string,
	options: StubOptions = {},
) {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			return [
				`[call ${toolName}] ${detailLine} (w=${width}${options.isError ? " err" : ""})`,
			];
		},
	};
}

export function renderBoxedToolResult(
	_theme: unknown,
	body: ((w: number) => string[]) | { render(w: number): string[] },
	options: StubOptions & { footerLines?: string[] } = {},
) {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			const lines =
				typeof body === "function" ? body(width) : body.render(width);
			return [
				`[result ${options.isError ? "error" : "ok"}]`,
				...lines,
				...(options.footerLines ?? []),
			];
		},
	};
}

export function renderCompactBoxedFooter(
	_theme: unknown,
	_result: unknown,
	options: StubOptions = {},
) {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			return [`[footer w=${width}${options.isError ? " err" : ""})`];
		},
	};
}

export function clearCompactBoxedFooter(state: unknown): void {
	if (state && typeof state === "object")
		delete (state as Record<string, unknown>).__footer;
}

export function boxedToolWidthKey(toolName: string, detail: string): string {
	return `${toolName}:${detail}`;
}

export function formatBoxedFooter(
	_theme: unknown,
	result: { details?: { __elapsedMs?: number } } | undefined,
	extraParts: string[] = [],
): string {
	const elapsed = result?.details?.__elapsedMs;
	const wall = elapsed === undefined ? "--" : `${(elapsed / 1000).toFixed(2)}s`;
	return [`◷ ${wall}`, ...extraParts].join(" · ");
}

export function renderLines(
	_theme: unknown,
	text: string,
	_options: unknown,
	opts: { maxLines?: number } = {},
): string {
	const lines = text.split("\n");
	return lines.slice(0, opts.maxLines ?? 20).join("\n");
}

export function isExpanded(
	options: { expanded?: boolean } | undefined,
): boolean {
	return Boolean(options?.expanded);
}
