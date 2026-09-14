/**
 * Read the last N bytes of a job log, without loading the whole file.
 * The cut point walks back over UTF-8 continuation bytes so a multibyte
 * character is never split mid-sequence.
 */
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

export interface Tail {
	text: string;
	bytes: number;
}

export async function readTail(
	logPath: string,
	maxBytes: number,
): Promise<Tail> {
	let handle: FileHandle;
	try {
		handle = await open(logPath, "r");
	} catch {
		return { text: "", bytes: 0 };
	}
	try {
		const size = (await handle.stat()).size;
		const length = Math.min(size, maxBytes);
		const start = size - length;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);

		let begin = 0;
		if (start > 0) {
			// start sits inside the file: drop a possibly partial first character
			while (
				begin < buffer.length &&
				begin < 4 &&
				((buffer[begin] ?? 0) & 0xc0) === 0x80
			)
				begin += 1;
		}
		return {
			text: buffer.subarray(begin).toString("utf8"),
			bytes: length - begin,
		};
	} finally {
		await handle.close();
	}
}
