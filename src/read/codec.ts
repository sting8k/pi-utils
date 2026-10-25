/**
 * mozjpeg encode + png/jpeg decode via jSquash (Squoosh codecs as WASM —
 * no native binaries). Decision 0015 amendment: photon's JPEG encoder is
 * 1.4-2.3x larger than mozjpeg at equal PSNR on the measured screenshots
 * and photos.
 *
 * The WASM files are compiled from disk and passed to init() explicitly, so
 * loading does not depend on import.meta.url fetch behavior of the host.
 * No pi imports.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export interface Pixels {
	/** Opaque RGBA (alpha flattened onto white). */
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

const require = createRequire(import.meta.url);

type JpegEncode = typeof import("@jsquash/jpeg/encode.js");
type JpegDecode = typeof import("@jsquash/jpeg/decode.js");
type PngDecode = typeof import("@jsquash/png/decode.js");
interface Codecs {
	jpegEncode: JpegEncode;
	jpegDecode: JpegDecode;
	pngDecode: PngDecode;
}

/** Structural ImageData: this project has no DOM lib. */
interface RawImage {
	data: Uint8ClampedArray;
	width: number;
	height: number;
	colorSpace?: string;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
	bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;

let codecs: Promise<Codecs> | undefined;

const wasm = (spec: string) =>
	WebAssembly.compile(readFileSync(require.resolve(spec)));

function load(): Promise<Codecs> {
	codecs ??= (async () => {
		const [jpegEncode, jpegDecode, pngDecode] = await Promise.all([
			import("@jsquash/jpeg/encode.js"),
			import("@jsquash/jpeg/decode.js"),
			import("@jsquash/png/decode.js"),
		]);
		await Promise.all([
			wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm").then((m) =>
				jpegEncode.init(m),
			),
			wasm("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm").then((m) =>
				jpegDecode.init(m),
			),
			wasm("@jsquash/png/codec/pkg/squoosh_png_bg.wasm").then((m) =>
				pngDecode.init(m),
			),
		]);
		return { jpegEncode, jpegDecode, pngDecode };
	})();
	// A failed load must not stick: the next read retries.
	codecs.catch(() => {
		codecs = undefined;
	});
	return codecs;
}

function flattenOnWhite(data: Uint8ClampedArray): void {
	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3] as number;
		if (alpha === 255) continue;
		const a = alpha / 255;
		for (let c = 0; c < 3; c++) {
			data[i + c] = Math.round((data[i + c] as number) * a + 255 * (1 - a));
		}
		data[i + 3] = 255;
	}
}

/** png/jpeg only; null for other formats (caller keeps the old path). */
export async function decodeImage(
	bytes: Uint8Array,
	mimeType: string,
): Promise<Pixels | null> {
	const { jpegDecode, pngDecode } = await load();
	let image: RawImage;
	if (mimeType === "image/png") {
		image = await pngDecode.default(toArrayBuffer(bytes));
	} else if (mimeType === "image/jpeg") {
		// true = apply the EXIF orientation (jSquash docs); the encoder drops EXIF.
		image = await jpegDecode.default(toArrayBuffer(bytes), {
			preserveOrientation: true,
		});
	} else {
		return null;
	}
	const data = new Uint8ClampedArray(image.data);
	flattenOnWhite(data);
	return { data, width: image.width, height: image.height };
}

/** Progressive mozjpeg at 4:4:4 — full-resolution chroma, so colors stay put. */
export async function encodeJpeg(
	pixels: Pixels,
	quality: number,
): Promise<Uint8Array> {
	const { jpegEncode } = await load();
	const out = await jpegEncode.default(
		{ ...pixels, colorSpace: "srgb" } as RawImage as Parameters<
			JpegEncode["default"]
		>[0],
		{ quality, auto_subsample: false, chroma_subsample: 1 },
	);
	return new Uint8Array(out);
}
