/**
 * pi-utils read — pi's read tool with lighter images (decision 0015).
 *
 * Wraps pi's own read definition (text reads, schema, renderers, structured
 * output stay pi's) and adds `original`. pi's read runs with
 * autoResizeImages: false; src/read/image.ts then does the single resize
 * pass: pi-utils limits by default, pi's limits with original: true.
 *
 * Settings: ~/.pi/agent/pi-utils.json "read" section; disabledTools: ["read"]
 * leaves pi's built-in read in place. Warnings are shown by the other
 * pi-utils extensions; this one only reads the settings.
 */
import {
	createReadToolDefinition,
	type ExtensionAPI,
	formatDimensionNote,
	getAgentDir,
	resizeImage,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	type PiUtilsSettings,
} from "../src/common/settings.ts";
import {
	type ImageResizeOptions,
	type ReadBlock,
	shrinkReadImage,
	toReadOutput,
} from "../src/read/image.ts";

export default function readExtension(pi: ExtensionAPI) {
	let settings: PiUtilsSettings = DEFAULT_SETTINGS;

	pi.on("session_start", async () => {
		settings = loadSettings(getAgentDir()).settings;
	});

	function registerRead(): void {
		const base = createReadToolDefinition(process.cwd(), {
			autoResizeImages: false,
		});
		pi.registerTool({
			...base,
			description: `${base.description} Large images are compressed to keep requests fast; pass original: true when you need full detail.`,
			parameters: Type.Object({
				...base.parameters.properties,
				original: Type.Optional(
					Type.Boolean({
						description:
							"Images only: skip pi-utils compression and send the image at pi's normal size limit. Larger images slow every later request; use it only when the compressed image lacks detail you need.",
					}),
				),
			}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const { original, ...readParams } = params as {
					original?: boolean;
				} & Parameters<typeof base.execute>[1];
				const result = await base.execute(
					toolCallId,
					readParams,
					signal,
					onUpdate,
					ctx,
				);
				const model = ctx?.model as
					| { inputLimits?: { images?: { resize?: ImageResizeOptions } } }
					| undefined;
				const content = await shrinkReadImage(result.content as ReadBlock[], {
					limits: settings.read,
					modelResize: model?.inputLimits?.images?.resize,
					original: original === true,
					deps: { resize: resizeImage, formatDimensionNote },
				});
				if (!content) return result;
				// pi >= 1.4 returns structuredContent (codemode's read output).
				return "structuredContent" in result
					? { ...result, content, structuredContent: toReadOutput(content) }
					: { ...result, content };
			},
		});
	}

	// Load settings once at init so disabledTools gates registration;
	// session_start reloads the limits.
	settings = loadSettings(getAgentDir()).settings;
	if (!settings.disabledTools.includes("read")) registerRead();
}
