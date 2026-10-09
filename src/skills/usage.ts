/**
 * US-005 — cross-session skill usage: how often each skill was read, with
 * exponential decay, so the tier-1 `core` group follows what the agent
 * actually uses NOW rather than all-time totals.
 *
 * One small JSON file under the agent dir: `{ skills: { <name>: { score, ts } } }`.
 * Keyed by skill NAME (not path) so usage survives moving a skill between
 * categories. `score` is the decayed use-count as of `ts` (ms epoch); a use
 * adds 1 after decaying the old score by 0.5^(age / HALF_LIFE). Entries that
 * decay below PRUNE_BELOW are dropped on write, so the file stays bounded by
 * what is actually in use.
 *
 * Corrupt / unreadable file → empty usage + a warning (never throws); the
 * next recorded use rewrites a fresh file. Writes are read-merge-write with
 * an atomic rename so two concurrent sessions lose at most one tick.
 *
 * Pure module: no pi imports.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const USAGE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BELOW = 0.05;

type UsageFile = { skills: Record<string, { score: number; ts: number }> };

function decayed(entry: { score: number; ts: number }, now: number): number {
	return (
		entry.score * 0.5 ** (Math.max(0, now - entry.ts) / USAGE_HALF_LIFE_MS)
	);
}

function isEntry(v: unknown): v is { score: number; ts: number } {
	if (typeof v !== "object" || v === null) return false;
	const e = v as { score?: unknown; ts?: unknown };
	return (
		typeof e.score === "number" &&
		Number.isFinite(e.score) &&
		typeof e.ts === "number" &&
		Number.isFinite(e.ts)
	);
}

function readFile(file: string): { data: UsageFile; warning?: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { data: { skills: {} } };
		}
		return { data: { skills: {} }, warning: `unreadable (${String(err)})` };
	}
	try {
		const parsed = JSON.parse(text) as { skills?: unknown };
		const raw = parsed?.skills;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { data: { skills: {} }, warning: "not a usage map" };
		}
		const skills: UsageFile["skills"] = {};
		for (const [name, entry] of Object.entries(raw)) {
			if (isEntry(entry)) skills[name] = entry;
		}
		return { data: { skills } };
	} catch (err) {
		return { data: { skills: {} }, warning: `corrupt JSON (${String(err)})` };
	}
}

/** Decayed score per skill name as of `now`. */
export function loadUsage(
	file: string,
	now: number,
): { scores: Map<string, number>; warning?: string } {
	const { data, warning } = readFile(file);
	const scores = new Map<string, number>();
	for (const [name, entry] of Object.entries(data.skills)) {
		scores.set(name, decayed(entry, now));
	}
	return { scores, warning };
}

/** Record one use of `name`. Best-effort: a failed write must never break a read. */
export function recordUse(file: string, name: string, now: number): void {
	try {
		const { data } = readFile(file);
		const prev = data.skills[name];
		data.skills[name] = {
			score: (prev ? decayed(prev, now) : 0) + 1,
			ts: now,
		};
		for (const [key, entry] of Object.entries(data.skills)) {
			if (decayed(entry, now) < PRUNE_BELOW) delete data.skills[key];
		}
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data)}\n`);
		renameSync(tmp, file);
	} catch {
		// usage is advisory
	}
}
