/**
 * US-004 — iteration nudge tracker (pure, for tests). Count tool iterations
 * since the last skill_write call; at `interval`, fire ONE line on a tool
 * result, then reset the counter. Any skill_write call resets the counter.
 * interval ≤ 0 disables entirely.
 */

export interface NudgeTracker {
	/** Feed every tool_call. skill_write resets; everything else counts. */
	onToolCall(isSkillWrite: boolean): void;
	/** Feed every tool_result. Returns the nudge line (fire-once) or null. */
	onToolResult(isError: boolean): string | null;
}

export function createNudgeTracker(interval: number): NudgeTracker {
	let count = 0;
	return {
		onToolCall(isSkillWrite) {
			if (isSkillWrite) {
				count = 0; // any skill_write call resets — per spec
				return;
			}
			count++;
		},
		onToolResult(isError) {
			if (interval <= 0 || count < interval) return null;
			if (isError) return null; // never graft onto an error result
			const line = `[skills] ${count} iters since last skill write — worth saving anything?`;
			count = 0; // fire once per interval, then count again
			return line;
		},
	};
}
