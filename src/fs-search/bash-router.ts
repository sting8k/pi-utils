/**
 * bash-router (US-001) — decide whether a bash command is a standalone, pure
 * filesystem search that the fs-search cores can re-execute 1:1.
 *
 * matchBashSearch(command) returns grep/glob params for provable searches and
 * null for everything else. Null always means "run real bash, unchanged" —
 * the matcher is conservative to a fault (packet spec:
 * docs/stories/US-001-bash-search-routing.md): any shell metacharacter
 * anywhere (even quoted), unlisted/unknown flags, glob-risky unquoted tokens,
 * weird quoting, or `=` outside the sanctioned `--include=` / `--color=`
 * forms rejects. Every loss falls through to bash, which handles it exactly
 * as before.
 *
 * No imports from pi packages (repo rule): pure string processing.
 */

import type { GlobParams } from "./glob-core.ts";
import type { GrepParams } from "./grep-core.ts";

export type RoutedSearch =
	| { kind: "grep"; params: GrepParams }
	| { kind: "glob"; params: GlobParams };

/** Rule 1: any of these anywhere — even inside quotes — rejects the command. */
const METACHAR = /[|&;<>`$~()\n\r]/;
/** Glob characters a path argument must not carry, quoted or not. */
const PATH_GLOB = /[*?[\]]/;
/** Unquoted glob/brace chars (rule 3): the shell may have rewritten argv. */
const UNQUOTED_EXPANSION = /[*?[\]{}]/;

interface Token {
	/** Unescaped value — what bash would pass as argv. */
	text: string;
	/** Unquoted fragment carries glob/brace chars: expansion is possible. */
	globRisk: boolean;
}

const isSpace = (ch: string): boolean =>
	ch === " " ||
	ch === "\t" ||
	ch === "\n" ||
	ch === "\r" ||
	ch === "\f" ||
	ch === "\v";

/**
 * Rule 2 tokenizer. `'...'` is literal (bash has no escapes inside single
 * quotes); `"..."` is literal but rejects `$` / backtick / backslash (it
 * still expands, or is quoting we do not model); bare tokens honor `\X`
 * escapes; a lone trailing `\`, an unbalanced quote, quote-glued text
 * (`'a'b`), a token starting with `#` (comment), or an empty token (`''`)
 * rejects — each would make argv differ from what the core could be given.
 */
function tokenize(command: string): Token[] | null {
	const tokens: Token[] = [];
	let text = "";
	let raw = "";
	let started = false;
	const flush = (): void => {
		if (started) {
			tokens.push({ text, globRisk: UNQUOTED_EXPANSION.test(raw) });
		}
		text = "";
		raw = "";
		started = false;
	};
	for (let i = 0; i < command.length; ) {
		const ch = command.charAt(i);
		if (isSpace(ch)) {
			flush();
			i += 1;
			continue;
		}
		if (!started && ch === "#") return null; // comment — argv would differ
		started = true;
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return null; // unbalanced quote
			text += command.slice(i + 1, end);
			i = end + 1;
			if (i < command.length && !isSpace(command.charAt(i))) return null;
			continue;
		}
		if (ch === '"') {
			const end = command.indexOf('"', i + 1);
			if (end === -1) return null; // unbalanced quote
			const inner = command.slice(i + 1, end);
			if (/[$`\\]/.test(inner)) return null; // expands in shell
			text += inner;
			i = end + 1;
			if (i < command.length && !isSpace(command.charAt(i))) return null;
			continue;
		}
		if (ch === "\\") {
			const next = command.charAt(i + 1);
			if (next === "") return null; // lone trailing backslash
			text += next;
			raw += next;
			i += 2;
			continue;
		}
		text += ch;
		raw += ch;
		i += 1;
	}
	flush();
	return tokens;
}

/**
 * Include globs map 1:1 only as a single positive glob: no negation, no
 * comma list, no `=` (keeps the rule-4 reject uniform), nothing flag-like.
 * The core re-validates and errors loudly if a bad value ever got through.
 */
function includeGlob(glob: string): string | null {
	if (glob === "" || glob.startsWith("!") || glob.startsWith("-")) return null;
	if (glob.includes(",") || glob.includes("=")) return null;
	return glob;
}

/** rg flags accepted and ignored — the core always adds or implies these. */
const RG_IGNORED = new Set([
	"-n",
	"--line-number",
	"--no-config",
	"--hidden",
	"-u",
	"-uu",
	"-uuu",
]);

/** Rule 5: rg — 1:1 flag mapping only; everything else rejects. */
function matchRg(tokens: Token[]): RoutedSearch | null {
	const params: Omit<GrepParams, "pattern"> = {};
	let pattern: string | undefined;
	let path: string | undefined;
	let awaitingContext = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) return null;
		const value = token.text;
		if (value.includes("=")) return null; // no sanctioned `=` forms for rg
		if (awaitingContext) {
			if (!/^\d+$/.test(value)) return null;
			params.context = Number.parseInt(value, 10);
			awaitingContext = false;
			continue;
		}
		if (value.startsWith("-")) {
			const combined = /^-C(\d+)$/.exec(value);
			if (combined !== null && combined[1] !== undefined) {
				params.context = Number.parseInt(combined[1], 10);
				continue;
			}
			if (value === "-C" || value === "--context") {
				awaitingContext = true;
				continue;
			}
			if (value === "-i" || value === "--ignore-case") {
				params.ignoreCase = true;
				continue;
			}
			if (value === "-F" || value === "--fixed-strings") {
				params.literal = true;
				continue;
			}
			if (value === "-g" || value === "--glob") {
				const globToken = tokens[i + 1];
				if (!globToken) return null;
				if (params.include !== undefined) return null; // single glob only
				const glob = includeGlob(globToken.text);
				if (glob === null) return null;
				params.include = glob;
				i += 1;
				continue;
			}
			if (RG_IGNORED.has(value)) continue;
			return null; // unknown flag ⇒ bash
		}
		// Positionals: first = pattern, rest = a single path.
		if (pattern === undefined) {
			if (token.globRisk) return null; // shell may have expanded it
			pattern = value;
			continue;
		}
		if (path !== undefined) return null; // single path only
		if (token.globRisk || PATH_GLOB.test(value)) return null;
		path = value;
	}
	if (awaitingContext) return null; // `-C` with no number
	if (pattern === undefined) return null;
	return {
		kind: "grep",
		params:
			path === undefined
				? { ...params, pattern }
				: { ...params, pattern, path },
	};
}

/** grep-family flags accepted and ignored (-E: core regex is a superset). */
const GREP_IGNORED = new Set([
	"-r",
	"-R",
	"--recursive",
	"-n",
	"-E",
	"--color",
]);

/** Rule 6: grep / ggrep / egrep / fgrep. */
function matchGrep(
	impliesLiteral: boolean,
	tokens: Token[],
): RoutedSearch | null {
	const params: Omit<GrepParams, "pattern"> = {};
	if (impliesLiteral) params.literal = true; // fgrep
	let pattern: string | undefined;
	let path: string | undefined;
	let recursive = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) return null;
		const value = token.text;
		if (value.includes("=")) {
			// Rule 4: `=` survives only in these sanctioned flag forms.
			if (/^--color=(auto|never)$/.test(value)) continue;
			const include = /^--include=(.+)$/.exec(value);
			if (include !== null && include[1] !== undefined) {
				if (params.include !== undefined) return null; // single glob only
				const glob = includeGlob(include[1]);
				if (glob === null) return null;
				params.include = glob;
				continue;
			}
			return null; // env assignment or unknown `=` form ⇒ bash
		}
		if (value.startsWith("-")) {
			if (value === "-i" || value === "--ignore-case") {
				params.ignoreCase = true;
				continue;
			}
			if (value === "-F") {
				params.literal = true;
				continue;
			}
			if (value === "-e") {
				const next = tokens[i + 1];
				if (!next) return null; // -e without a value
				if (pattern !== undefined) return null; // pattern already sourced
				if (next.globRisk || next.text.includes("=")) return null;
				pattern = next.text;
				i += 1;
				continue;
			}
			if (value === "--color") continue; // accept-ignore
			if (value === "--include") return null; // GNU grep requires `=`
			if (GREP_IGNORED.has(value)) {
				if (value === "-r" || value === "-R" || value === "--recursive") {
					recursive = true;
				}
				continue;
			}
			return null; // unknown or rejected flag ⇒ bash
		}
		// Positionals: first = pattern, rest = a single path.
		if (pattern === undefined) {
			if (token.globRisk) return null; // shell may have expanded it
			pattern = value;
			continue;
		}
		if (path !== undefined) return null; // single path only
		if (token.globRisk || PATH_GLOB.test(value)) return null;
		path = value;
	}
	if (pattern === undefined) return null;
	if (path === undefined && !recursive) return null; // stdin mode
	return {
		kind: "grep",
		params:
			path === undefined
				? { ...params, pattern }
				: { ...params, pattern, path },
	};
}

/** Rule 7: find → glob core. `-name` matches basenames, like a `/`-less glob. */
function matchFind(tokens: Token[]): RoutedSearch | null {
	let path: string | undefined;
	let name: string | undefined;
	let sawExpression = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) return null;
		const value = token.text;
		if (value.includes("=")) return null; // env assignment / unknown form
		if (!value.startsWith("-")) {
			// Paths precede expressions in find; at most one (multi-path is out
			// of scope). `!` would be the negation operator, not a path.
			if (path !== undefined || sawExpression) return null;
			if (value.startsWith("!")) return null;
			if (token.globRisk || PATH_GLOB.test(value)) return null;
			path = value;
			continue;
		}
		sawExpression = true;
		if (value === "-name") {
			const next = tokens[i + 1];
			if (!next || name !== undefined) return null; // exactly one -name
			if (next.globRisk) return null; // unquoted glob was shell-expanded
			const nameValue = next.text;
			if (nameValue === "" || nameValue.includes("/")) return null;
			if (
				nameValue.startsWith("-") ||
				nameValue.startsWith("!") ||
				nameValue.includes("=")
			) {
				return null; // operator-like values — not provable, fall through
			}
			name = nameValue;
			i += 1;
			continue;
		}
		if (value === "-print") continue; // accept-ignore
		return null; // -o -a -not -type -mtime -maxdepth -exec -iname … ⇒ bash
	}
	if (name === undefined) return null;
	return {
		kind: "glob",
		params: path === undefined ? { pattern: name } : { pattern: name, path },
	};
}

/**
 * Match a standalone, pure search command against the routing contract.
 * Returns grep/glob params the fs-search cores can execute 1:1, or null —
 * null always means "fall through to real bash, zero behavior change".
 */
export function matchBashSearch(command: string): RoutedSearch | null {
	if (METACHAR.test(command)) return null; // rule 1
	const tokens = tokenize(command);
	if (!tokens) return null;
	if (tokens.some((token) => token.text === "")) return null;
	const head = tokens[0];
	if (!head) return null;
	const rest = tokens.slice(1);
	switch (head.text) {
		case "rg":
			return matchRg(rest);
		case "grep":
		case "ggrep":
		case "egrep":
		case "fgrep":
			return matchGrep(head.text === "fgrep", rest);
		case "find":
			return matchFind(rest);
		default:
			return null;
	}
}
