/**
 * Droid-styling adaptation: loader resolution, graceful fallback, and the
 * session_start re-registration that attaches droid renderers to our tools.
 * The stub module (tests/fixtures/droid-stub.ts) stands in for the real
 * @sting8k/pi-droid-styling primitives via resetDroidRenderersForTests().
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	loadDroidRenderers,
	resetDroidRenderersForTests,
} from "../src/render/droid.ts";
import { grepMatchCount } from "../src/render/tool-renderers.ts";

const STUB = resolve(import.meta.dir, "fixtures/droid-stub.ts");

afterAll(() => {
	resetDroidRenderersForTests();
});

describe("loadDroidRenderers", () => {
	test("resolves the stub module and validates required primitives", async () => {
		resetDroidRenderersForTests(STUB);
		const droid = await loadDroidRenderers();
		expect(droid).not.toBeNull();
		expect(typeof droid?.renderCompactBoxedToolCall).toBe("function");
	});

	test("caches after first resolution", async () => {
		resetDroidRenderersForTests(STUB);
		const first = await loadDroidRenderers();
		const second = await loadDroidRenderers();
		expect(first).toBe(second);
	});

	test("unresolvable specifier falls back to null (default rendering)", async () => {
		resetDroidRenderersForTests("./no-such-module-anywhere.ts");
		const droid = await loadDroidRenderers();
		expect(droid).toBeNull();
	});

	test("module missing a required primitive is rejected", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-utils-droidstub-"));
		const partial = join(dir, "partial.ts");
		writeFileSync(
			partial,
			"export function boxedToolWidthKey() { return 'x'; }\n",
		);
		try {
			resetDroidRenderersForTests(partial);
			expect(await loadDroidRenderers()).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			resetDroidRenderersForTests();
		}
	});
});

describe("grepMatchCount", () => {
	test("counts path:line: rows only", () => {
		expect(grepMatchCount("No matches found.")).toBe(0);
		expect(
			grepMatchCount("3 matches in 2 files\na.ts:1: x\na.ts:2: y\nb.md:9: z"),
		).toBe(3);
	});
});

describe("extension re-registration with droid renderers", () => {
	/** Guarded cast: the renderer must exist by the time we call it. */
	function asRenderer(
		value: unknown,
	): (...a: unknown[]) => { render(w: number): string[] } {
		if (typeof value !== "function") throw new Error("renderer missing");
		return value as never as (...a: unknown[]) => {
			render(w: number): string[];
		};
	}

	function fakePi() {
		const tools: Array<Record<string, unknown>> = [];
		const handlers = new Map<
			string,
			Array<(event: unknown, ctx: unknown) => Promise<unknown>>
		>();
		const api = {
			registerTool: (tool: Record<string, unknown>) => tools.push(tool),
			registerCommand: () => {},
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown>,
			) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage: () => {},
		};
		return { api: api as unknown as ExtensionAPI, tools, handlers };
	}

	function fakeCtx(cwd: string): ExtensionContext {
		return {
			cwd,
			hasUI: false,
			ui: { notify: () => {}, setWidget: () => {} },
			sessionManager: { getSessionId: () => "render-droid-test" },
		} as unknown as ExtensionContext;
	}

	let agentDir = "";
	let root = "";

	beforeAll(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-utils-agentdir-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		// Explicit enabled-search baseline: DEFAULT now ships grep/glob
		// disabled (owner preference) — this suite asserts on grep rendering.
		writeFileSync(
			join(agentDir, "pi-utils.json"),
			JSON.stringify({ fsSearch: {}, shellBg: {}, disabledTools: [] }),
		);
		process.env.PI_SESSION_ID = "pi-utils-render-tests";
		root = mkdtempSync(join(tmpdir(), "pi-utils-render-"));
		writeFileSync(join(root, "a.md"), "hello render-test\n");
		resetDroidRenderersForTests(STUB);
	});
	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_SESSION_ID;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
		resetDroidRenderersForTests();
	});

	test("tools register without renderers at load, re-register with them after session_start", async () => {
		const { api, tools, handlers } = fakePi();
		const mod = await import("../extensions/fs-search.ts");
		mod.default(api);

		const atLoad = tools.filter((t) => t.name === "grep");
		expect(atLoad.length).toBe(1);
		expect(atLoad[0]?.renderCall).toBeUndefined();

		for (const handler of handlers.get("session_start") ?? []) {
			await handler(
				{ type: "session_start", reason: "startup" },
				fakeCtx(root),
			);
		}

		const greps = tools.filter((t) => t.name === "grep");
		expect(greps.length).toBe(2); // load + droid re-registration
		const withRender = greps.at(-1);
		expect(typeof withRender?.renderCall).toBe("function");
		expect(typeof withRender?.renderResult).toBe("function");

		const component = asRenderer(withRender?.renderCall)(
			{ pattern: "hello" },
			{},
			{ state: {} },
		);
		const lines = component.render(80);
		expect(lines[0]).toContain("[call Search]");
		expect(lines[0]).toContain("/hello/ in current directory");

		// Expanded result renders the metrics footer line (elapsed from details).
		const resultComponent = asRenderer(withRender?.renderResult)(
			{
				content: [
					{
						type: "text",
						text: "1 matches in 1 files\na.md:1: hello render-test",
					},
				],
				details: { __elapsedMs: 1500 },
			},
			{ expanded: true },
			{},
			{ state: {}, args: { pattern: "hello" } },
		);
		const resultLines = resultComponent.render(80);
		expect(resultLines[0]).toBe("[result ok]");
		expect(resultLines.join("\n")).toContain("↳ Found 1 match.");
		expect(resultLines.join("\n")).toContain("◷ 1.50s");
	});

	test("shell-bg bash gets droid renderers after session_start", async () => {
		const { api, tools, handlers } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		for (const handler of handlers.get("session_start") ?? []) {
			await handler(
				{ type: "session_start", reason: "startup" },
				fakeCtx(root),
			);
		}
		const bash = tools.filter((t) => t.name === "bash").at(-1);
		expect(typeof bash?.renderCall).toBe("function");
		const component = asRenderer(bash?.renderCall)(
			{ command: "npm run build", background: true },
			{},
			{ state: {} },
		);
		const lines = component.render(80);
		expect(lines[0]).toContain("[call Bash]");
		expect(lines[0]).toContain("npm run build");
		expect(lines[0]).toContain("(bg)");
	});
});
