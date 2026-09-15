/**
 * Glue tests: register the real extensions against a fake ExtensionAPI and
 * exercise the tool execute paths end-to-end (real rg, real shell — no pi).
 *
 * PI_CODING_AGENT_DIR is redirected to a temp dir so getAgentDir() (settings
 * scaffold, rg fallback) never touches the real ~/.pi/agent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../src/common/settings.ts";

interface Captured {
	tools: Array<
		Record<string, unknown> & {
			name: string;
			execute: (
				id: string,
				params: unknown,
				signal: AbortSignal | undefined,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<unknown>;
		}
	>;
	commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
	}>;
	messages: Array<{
		message: Record<string, unknown>;
		options: Record<string, unknown> | undefined;
	}>;
	handlers: Map<
		string,
		Array<(event: unknown, ctx: unknown) => Promise<unknown>>
	>;
}

function fakePi(): { api: ExtensionAPI; captured: Captured } {
	const captured: Captured = {
		tools: [],
		commands: [],
		messages: [],
		handlers: new Map(),
	};
	const api = {
		registerTool: (tool: never) => captured.tools.push(tool),
		registerCommand: (name: string, options: { handler: never }) =>
			captured.commands.push({ name, handler: options.handler }),
		on: (
			event: string,
			handler: (event: unknown, ctx: unknown) => Promise<unknown>,
		) => {
			const list = captured.handlers.get(event) ?? [];
			list.push(handler);
			captured.handlers.set(event, list);
		},
		sendMessage: (
			message: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => captured.messages.push({ message, options }),
	};
	return { api: api as unknown as ExtensionAPI, captured };
}

function fakeCtx(cwd: string, hasUI = false): ExtensionContext {
	return {
		cwd,
		hasUI,
		ui: { notify: () => {}, setWidget: () => {} },
		sessionManager: {
			getSessionId: () => process.env.PI_SESSION_ID ?? "glue-test",
		},
	} as unknown as ExtensionContext;
}

let agentDir = "";
let root = "";

beforeAll(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-utils-agentdir-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SESSION_ID = "pi-utils-tests";
	// Never import the real droid-styling here: pin an unresolvable module so
	// session_start's loadDroidRenderers() fails fast (default-rendering path).
	process.env.PI_UTILS_DROID_MODULE = "./__pi_utils_no_droid__.ts";
	root = mkdtempSync(join(tmpdir(), "pi-utils-glue-"));
	writeFileSync(join(root, "readme.md"), "# glue\nkeyword-glue here\n");
});
afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SESSION_ID;
	delete process.env.PI_UTILS_DROID_MODULE;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

async function startSession(
	captured: Captured,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of captured.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
}

describe("fs-search glue", () => {
	test("registers grep and glob with prompt snippets", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/fs-search.ts");
		mod.default(api);
		expect(captured.tools.map((t) => t.name).sort()).toEqual(["glob", "grep"]);
		for (const tool of captured.tools) {
			expect(tool.description).toBeTruthy();
			expect(tool.promptSnippet).toBeTruthy();
			expect(tool.parameters).toBeTruthy();
		}
	});

	test("glob execute returns mtime-sorted paths, including gitignored", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/fs-search.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const glob = captured.tools.find((t) => t.name === "glob");
		if (!glob) throw new Error("glob tool missing");
		const result = (await glob.execute(
			"t1",
			{ pattern: "*.md" },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(result.content[0]?.text).toContain("readme.md");
	});

	test("grep execute finds matches with line numbers", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/fs-search.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const grep = captured.tools.find((t) => t.name === "grep");
		if (!grep) throw new Error("grep tool missing");
		const result = (await grep.execute(
			"t2",
			{ pattern: "keyword-glue" },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(result.content[0]?.text).toContain("readme.md:2: keyword-glue here");
	});
});

describe("shell-bg glue", () => {
	test("registers bash (override), shell_status, shell_kill, /shell-bg", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		expect(captured.tools.map((t) => t.name).sort()).toEqual([
			"bash",
			"shell_kill",
			"shell_status",
		]);
		expect(captured.commands.map((c) => c.name)).toEqual(["shell-bg"]);
	});

	test("foreground bash runs and returns exit code with output", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		if (!bash) throw new Error("bash tool missing");
		const result = (await bash.execute(
			"t3",
			{ command: "echo foreground-ok" },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("exit 0");
		expect(result.content[0]?.text).toContain("foreground-ok");
	});

	test("background:true returns an id immediately; shell_status collects it", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		const status = captured.tools.find((t) => t.name === "shell_status");
		if (!bash || !status) throw new Error("tools missing");

		const started = (await bash.execute(
			"t4",
			{ command: "echo bg-ok", background: true },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			details: { id?: string };
		};
		const id = started.details.id;
		expect(typeof id).toBe("string");
		expect(started.content[0]?.text).toContain("started in the background");

		// Headless ctx: message says polling is required.
		expect(started.content[0]?.text).toContain("headless run");

		// Give the detached echo a moment to finish, then collect.
		await new Promise((resolve) => setTimeout(resolve, 700));
		const collected = (await status.execute(
			"t5",
			{ id },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			details: { status?: string };
		};
		expect(collected.details.status).not.toBe("running");
		expect(collected.content[0]?.text).toContain("bg-ok");
	});

	test("timeout kills the process and reports an error", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		if (!bash) throw new Error("bash tool missing");
		const result = (await bash.execute(
			"t6",
			{ command: "sleep 30", timeout: 1 },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Killed");
	});

	test("finished background job is delivered exactly once", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		if (!bash) throw new Error("bash tool missing");
		await bash.execute(
			"t7",
			{ command: "echo delivered-once", background: true },
			undefined,
			undefined,
			fakeCtx(root),
		);
		await new Promise((resolve) => setTimeout(resolve, 900));
		const deliveries = captured.messages.filter(
			(m) => m.message.customType === "pi-utils-shell-bg-result",
		);
		expect(deliveries.length).toBe(1);
		expect(String(deliveries[0]?.message.content)).toContain("delivered-once");
		expect(deliveries[0]?.options).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
	});

	test("pure search command routes to the fs-search core (US-001)", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		if (!bash) throw new Error("bash tool missing");
		const result = (await bash.execute(
			"t8",
			{ command: "rg keyword-glue" },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			details: Record<string, unknown>;
		};
		expect(result.content[0]?.text).toContain(
			"[fs-search] bash routed to grep semantics",
		);
		expect(result.content[0]?.text).toContain("readme.md:2: keyword-glue here");
		expect(result.details).toMatchObject({
			routed: true,
			kind: "grep",
			matchCount: 1,
		});
	});

	test("background, timeout, and non-search commands never route", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		if (!bash) throw new Error("bash tool missing");
		const asText = (r: unknown) =>
			(r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
		const asDetails = (r: unknown) =>
			(r as { details: Record<string, unknown> }).details;

		const bg = (await bash.execute(
			"t9",
			{ command: "rg keyword-glue", background: true },
			undefined,
			undefined,
			fakeCtx(root),
		)) as { content: Array<{ type: string; text: string }>; details: object };
		expect(asText(bg)).toContain("started in the background");
		expect(asDetails(bg).routed).toBeUndefined();

		const timed = (await bash.execute(
			"t10",
			{ command: "rg keyword-glue", timeout: 5 },
			undefined,
			undefined,
			fakeCtx(root),
		)) as { content: Array<{ type: string; text: string }>; details: object };
		expect(asText(timed)).toContain("exit 0");
		expect(asText(timed)).not.toContain("[fs-search]");
		expect(asDetails(timed).routed).toBeUndefined();

		const plain = (await bash.execute(
			"t11",
			{ command: "echo plain-ok" },
			undefined,
			undefined,
			fakeCtx(root),
		)) as { content: Array<{ type: string; text: string }>; details: object };
		expect(asText(plain)).toContain("plain-ok");
		expect(asText(plain)).not.toContain("[fs-search]");
		expect(asDetails(plain).routed).toBeUndefined();
	});

	test("wrapper-prefixed search routes via the settings whitelist (A1)", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const bash = captured.tools.find((t) => t.name === "bash");
		if (!bash) throw new Error("bash tool missing");
		const result = (await bash.execute(
			"t12",
			{ command: "rtk rg keyword-glue" },
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			details: Record<string, unknown>;
		};
		expect(result.content[0]?.text).toContain(
			"[fs-search] bash routed to grep semantics",
		);
		expect(result.details).toMatchObject({ routed: true, matchCount: 1 });
	});
});

describe("disabledTools glue (US-002)", () => {
	test("grep disabled → grep not registered, glob still is", async () => {
		writeFileSync(
			join(agentDir, "pi-utils.json"),
			JSON.stringify({ disabledTools: ["grep"] }),
		);
		const { api, captured } = fakePi();
		const mod = await import("../extensions/fs-search.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		expect(captured.tools.map((t) => t.name)).toEqual(["glob"]);
	});

	test("bash disabled → bash/status/kill not registered, widget not wired", async () => {
		writeFileSync(
			join(agentDir, "pi-utils.json"),
			JSON.stringify({ disabledTools: ["bash"] }),
		);
		const { api, captured } = fakePi();
		const mod = await import("../extensions/shell-bg.ts");
		mod.default(api);
		let widgetsWired = 0;
		const ctx = {
			cwd: root,
			hasUI: true,
			sessionManager: { getSessionId: () => "us002-glue" },
			ui: {
				notify: () => {},
				setWidget: () => {
					widgetsWired += 1;
				},
			},
		} as unknown as ExtensionContext;
		await startSession(captured, ctx);
		expect(captured.tools).toEqual([]);
		expect(widgetsWired).toBe(0);
		// Commands stay available; only the tools/widget cluster goes.
		expect(captured.commands.map((c) => c.name)).toEqual(["shell-bg"]);
	});
});

describe("edit glue (US-003)", () => {
	test("registers the edit override (script-only schema)", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/edit.ts");
		mod.default(api);
		const edit = captured.tools.find((t) => t.name === "edit");
		expect(edit).toBeTruthy();
		expect(edit?.description).toContain("script");
		// Steering lives in promptGuidelines (4 bullets), not the description.
		expect(edit?.promptGuidelines).toHaveLength(4);
	});

	test('edit is skipped under disabledTools: ["edit"]', async () => {
		writeFileSync(
			join(agentDir, "pi-utils.json"),
			JSON.stringify({ disabledTools: ["edit"] }),
		);
		const { api, captured } = fakePi();
		const mod = await import("../extensions/edit.ts");
		mod.default(api);
		expect(captured.tools).toEqual([]);
		// Restore defaults so later reads see a clean settings file.
		writeFileSync(
			join(agentDir, "pi-utils.json"),
			JSON.stringify(DEFAULT_SETTINGS),
		);
	});

	test("edit execute: script modifies a file; diff lands in content + details", async () => {
		const target = join(root, "edit-glue.txt");
		writeFileSync(target, "alpha\nbeta\n");
		const { api, captured } = fakePi();
		const mod = await import("../extensions/edit.ts");
		mod.default(api);
		await startSession(captured, fakeCtx(root));
		const edit = captured.tools.find((t) => t.name === "edit");
		if (!edit) throw new Error("edit tool missing");
		const result = (await edit.execute(
			"e1",
			{
				code: `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(target)}, "alpha\\nBETA\\n");`,
				paths: ["edit-glue.txt"],
				lang: "node",
			},
			undefined,
			undefined,
			fakeCtx(root),
		)) as {
			content: Array<{ type: string; text: string }>;
			details: { diff: string; patch: string; filesChanged: string[] };
		};
		expect(result.content[0]?.text).toContain("script edit: 1 file(s) changed");
		expect(result.content[0]?.text).toContain("+ BETA");
		expect(result.details.filesChanged).toEqual(["edit-glue.txt"]);
		expect(result.details.patch).toContain("--- a/edit-glue.txt");
		expect(readFileSync(target, "utf8")).toBe("alpha\nBETA\n");
	});

	test("edit execute: stray structured field is a hard error naming the fix", async () => {
		const { api, captured } = fakePi();
		const mod = await import("../extensions/edit.ts");
		mod.default(api);
		const edit = captured.tools.find((t) => t.name === "edit");
		if (!edit) throw new Error("edit tool missing");
		try {
			await edit.execute(
				"e2",
				{ code: "print(1)", paths: ["x.txt"], path: "x.txt" },
				undefined,
				undefined,
				fakeCtx(root),
			);
			expect.unreachable();
		} catch (err) {
			expect(String(err)).toContain('"path" is not a field');
		}
	});
});
