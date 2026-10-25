/**
 * read image compression (decision 0015).
 *
 * pi's read keeps images up to 2000px / 4.5 MB base64 — safe for the API but
 * heavy: every later request resends every image in the history. The
 * extension asks pi's read for the unmodified image; here pi's resizeImage
 * does decode + EXIF rotation + Lanczos resize to the pi-utils edge with the
 * byte cap lifted (lossless result), and the only lossy step is one mozjpeg
 * encode. `original: true` skips all of it and uses pi's own limits.
 *
 * Pure: pi's resizeImage / formatDimensionNote and the codecs are injected.
 */

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

export interface Pixels {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export interface ReadImageDeps {
	resize: (
		bytes: Uint8Array,
		mimeType: string,
		options?: ImageResizeOptions,
	) => Promise<ResizedImage | null>;
	formatDimensionNote: (result: ResizedImage) => string | undefined;
	/** png/jpeg → opaque RGBA; null for other formats. */
	decode: (bytes: Uint8Array, mimeType: string) => Promise<Pixels | null>;
	encodeJpeg: (pixels: Pixels, quality: number) => Promise<Uint8Array>;
}

export interface ReadImageLimits {
	/** Long-edge cap in px for both width and height. */
	imageMaxEdge: number;
	/** Cap on the base64 payload sent to the provider, in bytes. */
	imageMaxBytes: number;
}

export type ReadBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

// pi's resize defaults (utils/image-resize-core.js DEFAULT_OPTIONS), used
// when the model declares no inputLimits.images.resize.
const PI_MAX_EDGE = 2000;
const PI_MAX_BYTES = 4.5 * 1024 * 1024;

// JPEG quality range searched for the highest quality that fits the byte cap.
// 80 is where measured size/loss stops paying (q85 is ~12% bigger for ~1.5 dB);
// 40 is where text starts to smear.
const JPEG_Q_MAX = 80;
const JPEG_Q_MIN = 40;
// When even JPEG_Q_MIN does not fit, shrink by the area ratio the measured
// size implies (bytes ~ pixels) times this margin, bounded per step.
const SHRINK_MARGIN = 0.9;
const SHRINK_MIN_STEP = 0.3;
const SHRINK_MAX_STEP = 0.9;
const MIN_EDGE = 64;
const NO_BYTE_CAP = Number.MAX_SAFE_INTEGER;

const b64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

function size(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.round(bytes / 1024)} KB`;
}

/**
 * One lossy encode at the pi-utils caps. Returns pi's ResizedImage shape
 * (original dimensions kept for the coordinate note).
 */
async function compressImage(
	bytes: Uint8Array,
	mimeType: string,
	opts: {
		maxEdge: number;
		maxBytes: number;
		modelResize?: ImageResizeOptions;
		deps: ReadImageDeps;
	},
): Promise<ResizedImage | null> {
	const { maxBytes, modelResize, deps } = opts;
	let edge = opts.maxEdge;
	while (edge >= MIN_EDGE) {
		// Lossless at the target size (PNG, or the original when it already fits).
		const base = await deps.resize(bytes, mimeType, {
			...modelResize,
			maxWidth: edge,
			maxHeight: edge,
			maxBytes: NO_BYTE_CAP,
		});
		if (!base) break;
		if (base.data.length <= maxBytes) return base;
		const pixels = await deps.decode(
			new Uint8Array(Buffer.from(base.data, "base64")),
			base.mimeType,
		);
		if (!pixels) break; // gif/webp: pi's own resizer below
		const fit = await highestQualityThatFits(pixels, maxBytes, deps);
		if (fit.jpeg) {
			return {
				...base,
				data: Buffer.from(fit.jpeg).toString("base64"),
				mimeType: "image/jpeg",
				wasResized: true,
			};
		}
		const linear = Math.sqrt(maxBytes / b64Size(fit.minQualityBytes));
		edge = Math.floor(
			edge *
				Math.min(
					SHRINK_MAX_STEP,
					Math.max(SHRINK_MIN_STEP, linear * SHRINK_MARGIN),
				),
		);
	}
	// Formats the codecs cannot decode (gif/webp): pi's resizer with the byte
	// cap; if even that fails, pi's own limits.
	return (
		(await deps.resize(bytes, mimeType, {
			...modelResize,
			maxWidth: opts.maxEdge,
			maxHeight: opts.maxEdge,
			maxBytes,
		})) ?? deps.resize(bytes, mimeType, modelResize)
	);
}

async function highestQualityThatFits(
	pixels: Pixels,
	maxBytes: number,
	deps: ReadImageDeps,
): Promise<
	{ jpeg: Uint8Array } | { jpeg?: undefined; minQualityBytes: number }
> {
	// Most images fit at the top quality: try it first. If even the lowest
	// quality does not fit, report its size so the caller can shrink in one step.
	const top = await deps.encodeJpeg(pixels, JPEG_Q_MAX);
	if (b64Size(top.length) <= maxBytes) return { jpeg: top };
	const floor = await deps.encodeJpeg(pixels, JPEG_Q_MIN);
	if (b64Size(floor.length) > maxBytes) {
		return { minQualityBytes: floor.length };
	}
	let best = floor;
	let lo = JPEG_Q_MIN + 1;
	let hi = JPEG_Q_MAX - 1;
	while (lo <= hi) {
		const q = (lo + hi) >> 1;
		const out = await deps.encodeJpeg(pixels, q);
		if (b64Size(out.length) <= maxBytes) {
			best = out;
			lo = q + 1;
		} else {
			hi = q - 1;
		}
	}
	return { jpeg: best };
}

/**
 * Resize the image block of a read result (from pi's read with
 * autoResizeImages: false). Returns null when there is no image block.
 */
export async function shrinkReadImage(
	content: readonly ReadBlock[],
	opts: {
		limits: ReadImageLimits;
		/** ctx.model.inputLimits.images.resize — the model's own caps, if any. */
		modelResize?: ImageResizeOptions;
		original: boolean;
		deps: ReadImageDeps;
	},
): Promise<ReadBlock[] | null> {
	const image = content.find((block) => block.type === "image");
	if (image?.type !== "image") return null;
	const { limits, modelResize, original, deps } = opts;
	const bytes = new Uint8Array(Buffer.from(image.data, "base64"));

	const safeWidth = modelResize?.maxWidth ?? PI_MAX_EDGE;
	const safeHeight = modelResize?.maxHeight ?? PI_MAX_EDGE;
	const safeBytes = modelResize?.maxBytes ?? PI_MAX_BYTES;
	const tighter =
		limits.imageMaxEdge < Math.max(safeWidth, safeHeight) ||
		limits.imageMaxBytes < safeBytes;
	const compress = !original && tighter;

	const resized = compress
		? await compressImage(bytes, image.mimeType, {
				maxEdge: Math.min(limits.imageMaxEdge, Math.max(safeWidth, safeHeight)),
				maxBytes: Math.min(limits.imageMaxBytes, safeBytes),
				modelResize,
				deps,
			})
		: await deps.resize(bytes, image.mimeType, modelResize);

	const text = content.find((block) => block.type === "text");
	// pi's note: "Read image file [mime]" + conversion / non-vision lines.
	const extra =
		text?.type === "text" ? text.text.split("\n").slice(1) : ([] as string[]);
	if (!resized) {
		return [
			{
				type: "text",
				text: [
					`Read image file [${image.mimeType}]`,
					"[Image omitted: could not be resized below the inline image size limit.]",
					...extra,
				].join("\n"),
			},
		];
	}

	const lines = [`Read image file [${resized.mimeType}]`, ...extra];
	// pi's note also fires when only the bytes shrank ("multiply by 1.00").
	const scaled =
		resized.width !== resized.originalWidth ||
		resized.height !== resized.originalHeight;
	const dimension = scaled ? deps.formatDimensionNote(resized) : undefined;
	if (dimension) lines.push(dimension);
	if (compress && resized.data !== image.data) {
		lines.push(
			`[Compressed to ${size(resized.data.length)} to keep requests fast. If you need finer detail, read again with original: true; larger images slow every later request.]`,
		);
	}
	return [
		{ type: "text", text: lines.join("\n") },
		{ type: "image", data: resized.data, mimeType: resized.mimeType },
	];
}

/** pi's read structuredContent shape (pi >= 1.4), rebuilt for new content. */
export function toReadOutput(
	content: readonly ReadBlock[],
): string | { type: "image"; data: string; mimeType: string; note: string } {
	const text = content.find((block) => block.type === "text");
	const note = text?.type === "text" ? text.text : "";
	const image = content.find((block) => block.type === "image");
	return image?.type === "image"
		? { type: "image", data: image.data, mimeType: image.mimeType, note }
		: note;
}
