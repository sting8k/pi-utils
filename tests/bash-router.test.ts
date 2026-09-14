/**
 * bash-router unit tests (US-001) — accept matrix asserts exact mapped
 * params; reject matrix covers every danger case from the packet spec
 * (docs/stories/US-001-bash-search-routing.md, "Matcher spec").
 */
import { describe, expect, test } from "bun:test";
import { matchBashSearch } from "../src/fs-search/bash-router.ts";

/** Compact reject-case declaration: every entry must match null. */
function rejects(name: string, command: string): void {
	test(name, () => {
		expect(matchBashSearch(command)).toBeNull();
	});
}

describe("accept matrix — exact params", () => {
	test("rg <pattern> routes with pattern only", () => {
		expect(matchBashSearch("rg preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
	});

	test("rg -i/--ignore-case maps to ignoreCase", () => {
		expect(matchBashSearch("rg -i PRESET src")).toEqual({
			kind: "grep",
			params: { pattern: "PRESET", path: "src", ignoreCase: true },
		});
		expect(matchBashSearch("rg --ignore-case PRESET")).toEqual({
			kind: "grep",
			params: { pattern: "PRESET", ignoreCase: true },
		});
	});

	test("rg -F/--fixed-strings maps to literal", () => {
		expect(matchBashSearch("rg -F 'a.b'")).toEqual({
			kind: "grep",
			params: { pattern: "a.b", literal: true },
		});
		expect(matchBashSearch("rg --fixed-strings a.b src")).toEqual({
			kind: "grep",
			params: { pattern: "a.b", path: "src", literal: true },
		});
	});

	test("rg -C N / -CN / --context N maps to context", () => {
		expect(matchBashSearch("rg -C 2 preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset", context: 2 },
		});
		expect(matchBashSearch("rg -C2 preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset", context: 2 },
		});
		expect(matchBashSearch("rg --context 3 preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src", context: 3 },
		});
	});

	test("rg -g/--glob maps to include for a single positive glob", () => {
		expect(matchBashSearch("rg -g '*.ts' preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset", include: "*.ts" },
		});
		expect(matchBashSearch("rg --glob '*.ts' preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src", include: "*.ts" },
		});
	});

	test("rg accept-ignore flags produce no params", () => {
		expect(matchBashSearch("rg -n --no-config --hidden -uuu preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
	});

	test("rg combined accept case maps every flag 1:1", () => {
		expect(
			matchBashSearch("rg -i -F -C 1 -g '*.ts' --hidden preset src"),
		).toEqual({
			kind: "grep",
			params: {
				pattern: "preset",
				path: "src",
				include: "*.ts",
				ignoreCase: true,
				literal: true,
				context: 1,
			},
		});
	});

	test("quoted tokens keep spaces and escapes literal", () => {
		expect(matchBashSearch("rg 'foo bar'")).toEqual({
			kind: "grep",
			params: { pattern: "foo bar" },
		});
		expect(matchBashSearch('rg foo\\"bar src')).toEqual({
			kind: "grep",
			params: { pattern: 'foo"bar', path: "src" },
		});
		expect(matchBashSearch("rg pre\\'post")).toEqual({
			kind: "grep",
			params: { pattern: "pre'post" },
		});
	});

	test("grep family routes with recursive flags accepted", () => {
		expect(matchBashSearch("grep -r preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
		expect(matchBashSearch("grep -R preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src" },
		});
		expect(matchBashSearch("grep --recursive -n preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
		expect(matchBashSearch("ggrep -r preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
	});

	test("grep -i/-F map; fgrep implies literal; egrep routes plain", () => {
		expect(matchBashSearch("grep -i preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src", ignoreCase: true },
		});
		expect(matchBashSearch("grep -F preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src", literal: true },
		});
		expect(matchBashSearch("fgrep preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src", literal: true },
		});
		expect(matchBashSearch("egrep preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src" },
		});
	});

	test("grep -E and --color/--color=auto/never are accept-ignore", () => {
		expect(matchBashSearch("grep -E preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src" },
		});
		expect(matchBashSearch("grep --color -r preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
		expect(matchBashSearch("grep --color=auto -r preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset" },
		});
		expect(matchBashSearch("grep --color=never preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src" },
		});
	});

	test("grep -e sources the pattern; --include maps to include", () => {
		expect(matchBashSearch("grep -e preset src")).toEqual({
			kind: "grep",
			params: { pattern: "preset", path: "src" },
		});
		expect(matchBashSearch("grep --include='*.ts' -r preset")).toEqual({
			kind: "grep",
			params: { pattern: "preset", include: "*.ts" },
		});
	});

	test("find routes to the glob core", () => {
		expect(matchBashSearch("find . -name '*.ts'")).toEqual({
			kind: "glob",
			params: { pattern: "*.ts", path: "." },
		});
		expect(matchBashSearch("find -name '*.md'")).toEqual({
			kind: "glob",
			params: { pattern: "*.md" },
		});
		expect(matchBashSearch("find src -name '*.ts' -print")).toEqual({
			kind: "glob",
			params: { pattern: "*.ts", path: "src" },
		});
		expect(matchBashSearch("find . -print -name '*.ts'")).toEqual({
			kind: "glob",
			params: { pattern: "*.ts", path: "." },
		});
		expect(matchBashSearch("find . -name config")).toEqual({
			kind: "glob",
			params: { pattern: "config", path: "." },
		});
	});
});

describe("reject matrix — rule 1 metacharacters, anywhere (even quoted)", () => {
	rejects("pipe", "rg preset | head");
	rejects("ampersand", "rg preset && echo done");
	rejects("semicolon", "rg preset; echo done");
	rejects("redirect out", "rg preset > out");
	rejects("redirect in", "rg preset < in");
	rejects("backtick", "rg `ls` src");
	rejects("dollar, even quoted", "rg 'cost$' src");
	rejects("tilde", "rg preset ~");
	rejects("parens, even quoted", "rg 'f(x)' src");
	rejects("newline", "rg pre\nset");
});

describe("reject matrix — rules 2/3: tokenization and shell expansion", () => {
	rejects("unbalanced single quote", "rg 'unbalanced");
	rejects("unbalanced double quote", 'rg "unbalanced');
	rejects("lone trailing backslash", "rg trailing\\");
	rejects("unquoted glob positional", "rg preset *.ts");
	rejects("unquoted glob pattern", "rg foo*");
	rejects("unquoted -name value would be expanded", "find . -name *.ts");
	rejects("quote-glued text", "rg 'a'bc");
	rejects("empty quoted token", "rg '' src");
	rejects("comment token", "rg preset # note");
});

describe("reject matrix — rule 4: head token and `=`", () => {
	rejects("absolute grep path", "/usr/bin/grep preset src");
	rejects("absolute rg path", "/usr/bin/rg preset");
	rejects("relative rg path", "./rg preset");
	rejects("env-prefixed command", "FOO=1 rg preset");
	rejects("not a search head", "env rg preset");
	rejects("pattern with =", "rg key=value src");
	rejects("quoted pattern with =", "rg 'a=b' src");
	rejects("unknown = form for rg", "rg --context=2 preset");
	rejects("short flag with =", "rg -C=2 preset");
	rejects("--color=always", "grep --color=always preset");
});

describe("reject matrix — rule 5: rg unknown/unlisted flags", () => {
	for (const flag of [
		"-w",
		"-S",
		"-s",
		"-t",
		"-l",
		"-a",
		"-A",
		"-B",
		"-o",
		"-v",
		"-c",
		"--files",
		"--type",
		"--smart-case",
		"-e",
		"--unknown",
		"-rn",
	]) {
		rejects(`rg ${flag}`, `rg ${flag} preset src`);
	}
	rejects("negated glob", "rg -g '!*.ts' preset");
	rejects("comma glob", "rg -g '*.ts,*.md' preset");
	rejects("second glob", "rg -g '*.ts' -g '*.md' preset");
	rejects("two paths", "rg preset src src2");
	rejects("no pattern", "rg");
	rejects("flags but no pattern", "rg -i");
	rejects("-C without number", "rg -C preset");
	rejects("-C with non-number", "rg -C x preset");
	rejects("--context without number", "rg --context");
});

describe("reject matrix — rule 6: grep unknown/rejected flags and stdin mode", () => {
	for (const flag of [
		"-l",
		"-o",
		"-c",
		"-w",
		"-v",
		"-h",
		"-A",
		"-B",
		"-P",
		"--exclude",
		"--exclude-dir",
		"--unknown",
	]) {
		rejects(`grep ${flag}`, `grep ${flag} preset src`);
	}
	rejects("stdin mode without -r", "grep preset");
	rejects("stdin mode with -F", "grep -F preset");
	rejects("two -e patterns", "grep -e a -e b src");
	rejects("positional pattern plus -e", "grep preset -e other");
	rejects("-e without value", "grep -e");
	rejects("--include space form", "grep --include '*.ts' preset");
	rejects("negated include", "grep --include='!*.ts' preset");
	rejects("comma include", "grep --include='*.ts,*.md' preset");
	rejects("two paths", "grep preset src src2");
	rejects("no pattern", "grep -r");
});

describe("reject matrix — rule 7: find expressions beyond -name/-print", () => {
	for (const expr of [
		"-type f",
		"-mtime -1",
		"-maxdepth 2",
		"-iname '*.ts'",
		"-exec rm {}",
		"-not -name 'a'",
		"-size +1M",
	]) {
		rejects(`find ${expr}`, `find . ${expr}`);
	}
	rejects("no -name at all", "find .");
	rejects("-o operator", "find . -name 'a' -o -name 'b'");
	rejects("-a operator", "find . -name 'a' -a -print");
	rejects("-name value with slash", "find . -name 'a/b'");
	rejects("-name value with =", "find . -name 'a=b'");
	rejects("multi-path", "find src src2 -name 'a'");
	rejects("path after expression", "find . -name 'a' src");
	rejects("glob path", "find 'src*' -name 'a'");
	rejects("negation token as first arg", "find ! -name 'a'");
	rejects("missing -name value", "find . -name");
});

describe("reject matrix — extra conservative edges", () => {
	rejects("empty -name value", "find . -name ''");
	rejects("glob value starting with dash", "rg -g -i preset");
	rejects("unquoted brace expansion", "rg a{1,b} src");
});
