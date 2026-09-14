/**
 * Resolve the ripgrep binary — decision 0008 / D3:
 * PATH first, then pi's managed bin dir (<agentDir>/bin, where pi downloads rg
 * for its own built-in tools), then a clear error with install hints.
 * No @vscode/ripgrep bundling: pi already manages rg on this machine.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findOnPath(binary: string): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	const ext = process.platform === "win32" ? ".exe" : "";
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, `${binary}${ext}`);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

const INSTALL_HINT =
	"ripgrep (rg) not found. Install it (macOS: brew install ripgrep, Debian/Ubuntu: apt install " +
	"ripgrep), or run pi's built-in grep once so pi downloads rg into ~/.pi/agent/bin.";

/** Resolve the rg binary path. Throws with an install hint when unavailable. */
export function resolveRg(agentDir?: string): string {
	const onPath = findOnPath("rg");
	if (onPath) return onPath;

	if (agentDir) {
		const ext = process.platform === "win32" ? ".exe" : "";
		const candidate = join(agentDir, "bin", `rg${ext}`);
		if (isExecutable(candidate)) return candidate;
	}

	throw new Error(`SEARCH_FAILED: ${INSTALL_HINT}`);
}
