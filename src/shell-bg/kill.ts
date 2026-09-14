/**
 * Terminate a spawned job and its whole process tree.
 *
 * POSIX: spawn.ts started the shell detached, making it a process-group
 * leader, so killing the negative pid signals the whole tree: SIGTERM first,
 * SIGKILL after a grace period.
 * Windows: taskkill /T /F is the only reliable tree kill.
 *
 * Signals only — job settlement is observed via the spawn exit promise.
 */
import { spawnSync } from "node:child_process";

export function killTree(pid: number | null, graceMs: number): void {
	if (!pid || pid <= 0) return;

	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
			});
		} catch {
			// best effort
		}
		return;
	}

	const targets: [number, NodeJS.Signals][] = [
		[-pid, "SIGTERM"],
		[pid, "SIGTERM"],
	];
	for (const [target, sig] of targets) {
		try {
			process.kill(target, sig);
		} catch {
			// group may not exist; the direct kill usually does
		}
	}
	const grace = setTimeout(() => {
		for (const target of [-pid, pid]) {
			try {
				process.kill(target, "SIGKILL");
			} catch {
				// already dead
			}
		}
	}, graceMs);
	grace.unref?.();
}
