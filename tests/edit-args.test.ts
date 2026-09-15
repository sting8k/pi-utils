/**
 * Unit tests for the script-only edit override's argument layer (US-003):
 * alias normalization and validation errors that name the fix.
 */
import { describe, expect, test } from "bun:test";
import { normalizeEditArgs, resolveEditArgs } from "../src/edit/args.ts";

describe("normalizeEditArgs", () => {
	test("normalizes script/source → code and files/targets → paths", () => {
		expect(normalizeEditArgs({ script: "x", files: ["a"] })).toMatchObject({
			code: "x",
			paths: ["a"],
		});
		expect(normalizeEditArgs({ source: "x", targets: ["a"] })).toMatchObject({
			code: "x",
			paths: ["a"],
		});
	});

	test("timeoutMs converts to timeout seconds", () => {
		expect(normalizeEditArgs({ code: "x", timeoutMs: 5000 })).toMatchObject({
			timeout: 5,
		});
	});

	test("canonical fields win over aliases", () => {
		expect(
			normalizeEditArgs({ code: "canonical", script: "alias" }),
		).toMatchObject({ code: "canonical" });
		expect(
			normalizeEditArgs({ paths: ["canonical"], files: ["alias"] }),
		).toMatchObject({ paths: ["canonical"] });
	});
});

describe("resolveEditArgs", () => {
	test("accepts a minimal valid input", () => {
		const args = resolveEditArgs(
			normalizeEditArgs({ code: "print(1)", paths: ["a.txt"] }),
		);
		expect(args).toMatchObject({
			code: "print(1)",
			paths: ["a.txt"],
			lang: undefined,
			timeout: undefined,
		});
	});

	test("missing code errors with a minimal example", () => {
		expect(() =>
			resolveEditArgs(normalizeEditArgs({ paths: ["a.txt"] })),
		).toThrow(/"code" is required/);
		expect(() =>
			resolveEditArgs(normalizeEditArgs({ paths: ["a.txt"] })),
		).toThrow(/"paths"/);
	});

	test("missing or empty paths errors naming the fix", () => {
		expect(() => resolveEditArgs(normalizeEditArgs({ code: "x" }))).toThrow(
			/"paths" is required — declare every file/,
		);
		expect(() =>
			resolveEditArgs(normalizeEditArgs({ code: "x", paths: [] })),
		).toThrow(/"paths" is required/);
		expect(() =>
			resolveEditArgs(normalizeEditArgs({ code: "x", paths: [""] })),
		).toThrow(/"paths" is required/);
	});

	test("stray structured fields are a hard error naming the fix", () => {
		for (const field of ["path", "edits", "oldText", "newText", "all"]) {
			expect(() =>
				resolveEditArgs(
					normalizeEditArgs({ code: "x", paths: ["a"], [field]: "y" }),
				),
			).toThrow(new RegExp(`script-mode edit: "${field}" is not a field`));
		}
	});

	test("single-path aliases are NOT normalized — they error pointing to paths", () => {
		for (const field of ["file_path", "file", "filename", "target_file"]) {
			expect(() =>
				resolveEditArgs(normalizeEditArgs({ code: "x", [field]: "a.txt" })),
			).toThrow(/declare files in "paths"/);
		}
	});

	test("invalid lang and timeout error", () => {
		expect(() =>
			resolveEditArgs(
				normalizeEditArgs({ code: "x", paths: ["a"], lang: "ruby" }),
			),
		).toThrow(/"lang" must be "python" or "node"/);
		expect(() =>
			resolveEditArgs(
				normalizeEditArgs({ code: "x", paths: ["a"], timeout: -1 }),
			),
		).toThrow(/"timeout" must be a positive number/);
	});
});
