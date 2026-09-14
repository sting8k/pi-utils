/**
 * Spill files for truncated search results (decision 0008 / D5): write the full
 * output to a temp file and hand the model a locator line. No versioned spill
 * store — the model can `read` the file with offset if it needs more.
 */
import {
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPILL_DIR = join(tmpdir(), "pi-utils-spill");

function sanitize(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
}

/** Write a spill file and return its absolute path. Throws on I/O failure — callers report it. */
export function writeSpill(label: string, content: string): string {
	mkdirSync(SPILL_DIR, { recursive: true });
	const file = join(SPILL_DIR, `${Date.now()}-${sanitize(label)}.log`);
	writeFileSync(file, content);
	return file;
}

/** Best-effort cleanup of spill files older than maxAgeMs. Never throws. */
export function cleanupSpills(maxAgeMs = 24 * 60 * 60 * 1000): void {
	try {
		const entries = readdirSync(SPILL_DIR);
		const now = Date.now();
		for (const entry of entries) {
			const file = join(SPILL_DIR, entry);
			try {
				if (now - statSync(file).mtimeMs > maxAgeMs) rmSync(file);
			} catch {
				// racing deletion — ignore
			}
		}
	} catch {
		// no dir or unreadable — nothing to clean
	}
}
