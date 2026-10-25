/**
 * read image compression (decision 0015).
 *
 * pi's read keeps images up to 2000px / 4.5 MB base64 — safe for the API but
 * heavy: every later request resends every image in the history. The
 * extension asks pi's read for the unresized image and runs ONE resize pass
 * here with the tighter pi-utils limits (two lossy passes would stack
 * artifacts). `original: true` runs the same pass with pi's own limits.
 *
 * Pure: pi's resizeImage / formatDimensionNote are injected by the extension.
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

export interface ReadImageDeps {
	resize: (
		bytes: Uint8Array,
		mimeType: string,
		options?: ImageResizeOptions,
	) => Promise<ResizedImage | null>;
	formatDimensionNote: (result: ResizedImage) => string | undefined;
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

function size(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.round(bytes / 1024)} KB`;
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

	let resized = await deps.resize(
		bytes,
		image.mimeType,
		compress
			? {
					...modelResize,
					maxWidth: Math.min(limits.imageMaxEdge, safeWidth),
					maxHeight: Math.min(limits.imageMaxEdge, safeHeight),
					maxBytes: Math.min(limits.imageMaxBytes, safeBytes),
				}
			: modelResize,
	);
	// Could not reach the tight caps: fall back to pi's limits.
	if (!resized && compress) {
		resized = await deps.resize(bytes, image.mimeType, modelResize);
	}

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
	if (compress && resized.wasResized) {
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
