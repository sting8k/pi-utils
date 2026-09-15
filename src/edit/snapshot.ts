/**
 * In-memory snapshot of the declared paths (US-003) — the rollback surface.
 * Absent files are recorded as absent so scripts may create them; on
 * rollback they are deleted again. No git — this map is the whole contract
 * boundary (owner decision): the tool observes, diffs, and restores exactly
 * these paths and nothing else.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** Warn (never block) when the total snapshot exceeds this many bytes. */
const SNAPSHOT_WARN_BYTES = 50 * 1024 * 1024;

export interface SnapshotEntry {
	path: string;
	present: boolean;
	content: Buffer | null;
}

export interface PathSnapshot {
	entries: SnapshotEntry[];
	/** Non-fatal notes (e.g. large total size) — surfaced in the result. */
	warnings: string[];
	/**
	 * Restore every entry to its snapshot state. Best-effort per file;
	 * returns the paths that could not be restored.
	 */
	restore(): string[];
}

function isNotFound(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

export function snapshotPaths(paths: string[]): PathSnapshot {
	const entries: SnapshotEntry[] = [];
	const warnings: string[] = [];
	let totalBytes = 0;

	for (const path of paths) {
		try {
			const content = readFileSync(path);
			totalBytes += content.length;
			entries.push({ path, present: true, content });
		} catch (err) {
			if (isNotFound(err)) {
				// Absent on purpose: scripts may create the file.
				entries.push({ path, present: false, content: null });
			} else {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Could not snapshot declared path ${path}: ${message}`);
			}
		}
	}

	if (totalBytes > SNAPSHOT_WARN_BYTES) {
		const mb = (totalBytes / (1024 * 1024)).toFixed(1);
		warnings.push(
			`snapshot of declared paths is large (${mb} MB) — proceeding, but prefer smaller targets`,
		);
	}

	return {
		entries,
		warnings,
		restore(): string[] {
			const failed: string[] = [];
			for (const entry of entries) {
				try {
					if (entry.present && entry.content !== null) {
						writeFileSync(entry.path, entry.content);
					} else if (!entry.present) {
						rmSync(entry.path, { force: true });
					}
				} catch {
					failed.push(entry.path);
				}
			}
			return failed;
		},
	};
}
