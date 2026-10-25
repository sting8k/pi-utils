/**
 * read extension (decision 0015): image compression through the real tool
 * entrypoint and pi's real resizer, on generated PNGs.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	let crc = 0xffffffff;
	for (const byte of body)
		crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
	return out;
}

/** RGB PNG; noise makes it incompressible so it really exceeds the caps. */
function png(width: number, height: number, noise: boolean): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const raw = Buffer.alloc((width * 3 + 1) * height);
	if (noise) for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 256;
	for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0; // filter: none
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

type Block = { type: string; text?: string; data?: string };
type ReadTool = {
	parameters: { properties: Record<string, unknown> };
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Block[] }>;
};

let dir: string;
let read: ReadTool;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pi-utils-read-"));
	process.env.PI_CODING_AGENT_DIR = dir; // fresh defaults, never the real home
	writeFileSync(join(dir, "big.png"), png(1700, 300, true));
	writeFileSync(join(dir, "small.png"), png(32, 32, false));
	const tools: ReadTool[] = [];
	const { default: readExtension } = await import("../extensions/read.ts");
	readExtension({
		registerTool: (tool: ReadTool) => tools.push(tool),
		on: () => {},
	} as unknown as ExtensionAPI);
	read = tools[0] as ReadTool;
});

const run = (params: Record<string, unknown>) =>
	read.execute("t", params, undefined, undefined, { cwd: dir });

describe("read image compression", () => {
	test("over the caps: compressed by default, pi's limits with original", async () => {
		expect(read.parameters.properties.original).toBeDefined();

		const small = await run({ path: "big.png" });
		const [note, image] = small.content;
		expect(image?.type).toBe("image");
		expect((image?.data ?? "").length).toBeLessThanOrEqual(200 * 1024);
		expect(note?.text).toContain("displayed at");
		expect(note?.text).toContain("original: true");

		const full = await run({ path: "big.png", original: true });
		expect((full.content[1]?.data ?? "").length).toBeGreaterThan(200 * 1024);
		expect(full.content[0]?.text).not.toContain("Compressed");
	});

	test("under the caps: image sent unchanged, no note", async () => {
		const result = await run({ path: "small.png" });
		expect(result.content[1]?.data).toBe(png(32, 32, false).toString("base64"));
		expect(result.content[0]?.text).toBe("Read image file [image/png]");
	});
});
