/**
 * US-005 tier 2 — per-turn skill hint. A lexical (BM25F-lite, no embeddings)
 * ranker over the skills the tier-1 catalog already knows, queried with the
 * user prompt plus language-neutral session signals (cwd, recently touched
 * paths, tool / command names). Prompts are often Vietnamese while
 * descriptions are English, so the signals carry most of the weight for
 * non-English prompts; this is best-effort by design.
 *
 * Fields: skill name ×3, tags ×2, description ×1. IDF down-weights words every
 * description shares ("use when"), so no stopword list is needed. A hint needs
 * a score floor — see HINT_MIN_SCORE for the calibration.
 *
 * Pure module: no pi imports, no fs access.
 */
import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";
import { truncateDesc, type VisibleSkill } from "./index-transform.ts";

export const HINT_MAX = 4;
export const HINT_DESC_MAX = 120;
/**
 * Calibrated by hand on a real set of a few hundred skills (US-005 doc):
 * one rare word in a skill NAME scores ≈6–9, one rare description-only word
 * ≈3–5, and incidental single-word matches cluster at 4–6. ≥ 7 admits "a
 * name/tag hit or two good description hits"; a hit must also reach half of
 * the best score so one strong match is not padded with weak ones.
 */
export const HINT_MIN_SCORE = 7;
const HINT_TAIL_RATIO = 0.5;

const FIELD_WEIGHT = { name: 3, tags: 2, desc: 1 } as const;
const K1 = 1.2;
const B = 0.75;
const PROMPT_CHARS = 2000;
const ACTIVITY_PATHS = 12;
const ACTIVITY_NAMES = 12;
/** Built-in tools carry no topical signal; only extra tools / bash heads do. */
const BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"ls",
	"find",
	"grep",
	"glob",
	"skill_write",
	"shell_status",
	"shell_kill",
]);

/** English function words: they sit in kebab-case names ("…-is-…", "…-for-…") and would score as name hits. */
const STOPWORDS = new Set(
	"a an and are as at be but by can do does for from has have how if in into is it its not of on or so than that the then this to use used uses using was what when where which who why will with without you your".split(
		" ",
	),
);

/** Lowercase word tokens with a tiny shared suffix stem (applied to both sides). */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
		const word = m[0];
		if (word.length < 2 || STOPWORDS.has(word)) continue;
		out.push(stem(word));
	}
	return out;
}

function stem(word: string): string {
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
			return word.slice(0, -suffix.length);
		}
	}
	return word;
}

interface Doc {
	skill: VisibleSkill;
	/** term → field-weighted frequency */
	tf: Map<string, number>;
	len: number;
}

export interface HintIndex {
	docs: Doc[];
	df: Map<string, number>;
	avgLen: number;
}

export function buildHintIndex(skills: VisibleSkill[]): HintIndex {
	const df = new Map<string, number>();
	const docs: Doc[] = skills.map((skill) => {
		const tf = new Map<string, number>();
		let len = 0;
		const add = (text: string, weight: number) => {
			for (const t of tokenize(text)) {
				tf.set(t, (tf.get(t) ?? 0) + weight);
				len += 1;
			}
		};
		add(skill.name, FIELD_WEIGHT.name);
		add(skill.tags.join(" "), FIELD_WEIGHT.tags);
		add(skill.description, FIELD_WEIGHT.desc);
		for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
		return { skill, tf, len };
	});
	const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
	return { docs, df, avgLen };
}

/** Skills above the score floor, best first, at most HINT_MAX, minus `exclude` (by name). */
export function rankHints(
	index: HintIndex,
	query: Set<string>,
	exclude: Set<string>,
): VisibleSkill[] {
	const scored = scoreAll(index, query, exclude);
	const floor = Math.max(
		HINT_MIN_SCORE,
		(scored[0]?.score ?? 0) * HINT_TAIL_RATIO,
	);
	return scored
		.filter((s) => s.score >= floor)
		.slice(0, HINT_MAX)
		.map((s) => s.skill);
}

export function scoreAll(
	index: HintIndex,
	query: Set<string>,
	exclude: Set<string>,
): Array<{ skill: VisibleSkill; score: number }> {
	const n = index.docs.length;
	const scored: Array<{ skill: VisibleSkill; score: number }> = [];
	for (const doc of index.docs) {
		if (exclude.has(doc.skill.name)) continue;
		let score = 0;
		for (const term of query) {
			const tf = doc.tf.get(term);
			if (!tf) continue;
			const df = index.df.get(term) ?? 0;
			const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
			const norm = K1 * (1 - B + (B * doc.len) / index.avgLen);
			score += (idf * tf * (K1 + 1)) / (tf + norm);
		}
		if (score > 0) scored.push({ skill: doc.skill, score });
	}
	return scored.sort(
		(a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
	);
}

/** Rolling record of what the session has touched (paths, tool / command names). */
export interface ActivityLog {
	note(toolName: string, input: unknown): void;
	/** Query tokens: cwd's last two segments + recent paths + names. */
	tokens(cwd: string): Set<string>;
}

export function createActivityLog(): ActivityLog {
	const paths: string[] = [];
	const names: string[] = [];
	const push = (list: string[], max: number, value: string) => {
		list.push(value);
		if (list.length > max) list.shift();
	};
	return {
		note(toolName, input) {
			if (!BUILTIN_TOOLS.has(toolName)) push(names, ACTIVITY_NAMES, toolName);
			if (typeof input !== "object" || input === null) return;
			const { path, file_path, command } = input as Record<string, unknown>;
			for (const p of [path, file_path]) {
				if (typeof p === "string" && p) push(paths, ACTIVITY_PATHS, p);
			}
			if (toolName === "bash" && typeof command === "string") {
				// First real word: skip `VAR=x` prefixes.
				const head = command
					.trim()
					.split(/\s+/)
					.find((w) => !/^\w+=/.test(w));
				if (head) push(names, ACTIVITY_NAMES, basename(head));
			}
		},
		tokens(cwd) {
			const out = new Set<string>();
			const add = (text: string) => {
				for (const t of tokenize(text)) out.add(t);
			};
			add(cwd.split(sep).filter(Boolean).slice(-2).join(" "));
			for (const p of paths) add(`${basename(dirname(p))} ${basename(p)}`);
			for (const name of names) add(name);
			return out;
		},
	};
}

/** Query = prompt words ∪ session signals. */
export function buildQuery(prompt: string, signals: Set<string>): Set<string> {
	const query = new Set(signals);
	for (const t of tokenize(prompt.slice(0, PROMPT_CHARS))) query.add(t);
	return query;
}

/** Hint message body — compact: one line per skill, `~`-abbreviated path. */
export function formatHint(skills: VisibleSkill[]): string {
	const home = homedir();
	const lines = skills.map((s) => {
		const loc = s.location.startsWith(`${home}/`)
			? `~${s.location.slice(home.length)}`
			: s.location;
		return `- ${loc} — ${truncateDesc(s.description, HINT_DESC_MAX)}`;
	});
	return `Skills that may apply (read before starting if relevant):\n${lines.join("\n")}`;
}
