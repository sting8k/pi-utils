/**
 * Per-path mutation mutex for edit windows (US-003 Execution §2).
 *
 * Two concurrent edit calls touching the same file would otherwise race:
 * call B snapshots clean, A writes, and B's diff misattributes A's write.
 * The lock is held across the WHOLE window (snapshot → script → diff →
 * rollback), so a later call snapshots and diffs only its own script's
 * writes. Serializing never fails: the next call waits, then runs.
 *
 * Pure and pi-free. Callers acquire ALL declared paths — in sorted path
 * order, which makes the global acquisition order total and deadlock-free.
 * Disjoint path sets still run in parallel (per-path, not global).
 */

const queues = new Map<string, Promise<unknown>>();

async function acquire(key: string): Promise<() => void> {
	let release!: () => void;
	const ticket = new Promise<void>((resolve) => {
		release = resolve;
	});
	const previous = queues.get(key) ?? Promise.resolve();
	// Chain the next waiter onto our release, whatever our fate.
	queues.set(
		key,
		previous.then(
			() => ticket,
			() => ticket,
		),
	);
	await previous.catch(() => {});
	return release;
}

/**
 * Run `fn` while holding locks on every path. Locks are acquired in sorted
 * path order (deadlock-free total order) and always released — including
 * when `fn` throws.
 */
export async function withPathLocks<T>(
	paths: string[],
	fn: () => Promise<T>,
): Promise<T> {
	const sorted = [...new Set(paths)].sort();
	const releases: Array<() => void> = [];
	try {
		for (const key of sorted) {
			releases.push(await acquire(key));
		}
		return await fn();
	} finally {
		for (const release of releases.reverse()) release();
	}
}
