/**
 * Helpers preloaded into every edit script: an anchored replace that fails
 * loudly. The bare `str.replace` path exits 0 on a missed anchor and leaves
 * a silent partial edit; here a match-count mismatch exits non-zero, so the
 * tool rolls every declared path back.
 *
 * The agent's own code keeps its line numbers: python compiles it as
 * "<edit>" (tracebacks read `File "<edit>", line N`), node gets the prelude
 * prepended on the same first line.
 */

const PYTHON_PRELUDE = `def replace_once(path, old, new, count=1):
    if not old:
        raise SystemExit(f"replace_once: empty anchor for {path}")
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    found = text.count(old)
    if found != count:
        raise SystemExit(f"replace_once: expected {count} match(es) of {old[:80]!r} in {path}, found {found}")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace(old, new))
    return found
`;

// One line, no trailing newline: the agent's line 1 stays line 1. fs comes
// from require when the stdin script is CommonJS, else getBuiltinModule (ESM).
const NODE_PRELUDE =
	"const replaceOnce = (path, old, replacement, count = 1) => { " +
	'const fs = typeof require === "function" ? require("node:fs") : process.getBuiltinModule("node:fs"); ' +
	'if (!old) { console.error("replaceOnce: empty anchor for " + path); process.exit(1); } ' +
	'const text = fs.readFileSync(path, "utf8"); const parts = text.split(old); const found = parts.length - 1; ' +
	'if (found !== count) { console.error("replaceOnce: expected " + count + " match(es) of " + JSON.stringify(old.slice(0, 80)) + " in " + path + ", found " + found); process.exit(1); } ' +
	"fs.writeFileSync(path, parts.join(replacement)); return found; }; ";

/** The stdin payload: helpers + the agent's code, line numbers preserved. */
export function withPrelude(lang: "python" | "node", code: string): string {
	if (lang === "node") return NODE_PRELUDE + code;
	// A JSON string literal is a valid python string literal.
	return `${PYTHON_PRELUDE}exec(compile(${JSON.stringify(code)}, "<edit>", "exec"), {"__name__": "__main__", "replace_once": replace_once})\n`;
}
