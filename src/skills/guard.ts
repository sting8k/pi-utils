/**
 * US-004 — session-scoped seen-map: which SKILL.md files the read tool
 * actually loaded this session. Consumers: the read-before-write guard
 * (patch/delete require a seen skill) and the tier-2 hint (never re-hint a
 * skill already read).
 *
 * Keys are RESOLVED absolute paths (extension resolves the read input against
 * cwd before marking). bash `cat` never marks — tracking keys on the read
 * tool only (spec: same strictness as hermes).
 *
 * Pure module: no pi imports, no fs access.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

export interface SeenMap {
	/** Record a resolved SKILL.md path as read (dedupes silently). */
	mark(path: string): void;
	/** True when this exact resolved SKILL.md path was read this session. */
	has(path: string): boolean;
	/** A seen SKILL.md moved: the entry follows it (no-op when `from` was unseen). */
	rename(from: string, to: string): void;
	/** Snapshot of all seen paths. */
	paths(): string[];
}

export function createSeenMap(): SeenMap {
	const seen = new Set<string>();
	return {
		mark(path) {
			seen.add(path);
		},
		has(path) {
			return seen.has(path);
		},
		rename(from, to) {
			if (seen.delete(from)) seen.add(to);
		},
		paths() {
			return [...seen];
		},
	};
}

/**
 * `requires` visibility check with a session cache: is the binary on PATH?
 * Portable scan of the PATH dirs (no shell-out, works on all platforms).
 */
export function createRequiresChecker(
	env: Record<string, string | undefined>,
): (bin: string) => boolean {
	const cache = new Map<string, boolean>();
	const sep = process.platform === "win32" ? ";" : ":";
	const dirs = (env.PATH ?? "").split(sep).filter((dir) => dir.length > 0);
	const exts =
		process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	return (bin: string): boolean => {
		const cached = cache.get(bin);
		if (cached !== undefined) return cached;
		let found = false;
		for (const dir of dirs) {
			for (const ext of exts) {
				if (exists(join(dir, `${bin}${ext}`))) {
					found = true;
					break;
				}
			}
			if (found) break;
		}
		cache.set(bin, found);
		return found;
	};
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
