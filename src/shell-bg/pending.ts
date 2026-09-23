/**
 * The messages a backgrounded command produces — when it is sent to the
 * background, and when it comes back.
 *
 * Two audiences, one hard constraint: delivery (pushing the finished result
 * into the conversation unasked) only works if the session outlives the run.
 * An interactive session does; a headless `pi -p` run tears down when the
 * prompt resolves, so the not-ready message tells the truth for its mode:
 * interactive can wait, headless must collect within the turn.
 *
 * Design credit: pifydev/shell-background (MIT).
 */

export interface BackgroundedInput {
	id: string;
	command: string;
	elapsedMs: number;
	/** True on the auto-threshold path, false when the caller asked for background. */
	auto: boolean;
	/** Whether a UI/interactive session is present to deliver into. */
	interactive: boolean;
	/** The tool to collect with: "shell_status". */
	collectWith: string;
}

function elapsed(ms: number): string {
	if (ms < 1000) return "just now";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function clip(command: string, max = 60): string {
	const one = command.replace(/\s+/g, " ").trim();
	return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export interface BackgroundedResult {
	text: string;
	details: {
		id: string;
		status: "running";
		background: true;
		auto: boolean;
		retryable: true;
		pollRequired: boolean;
		elapsedMs: number;
	};
}

export function backgroundedResult(
	input: BackgroundedInput,
): BackgroundedResult {
	const head = input.auto
		? `${input.id} is still running after ${elapsed(input.elapsedMs)} — moved to the background.`
		: `${input.id} started in the background.`;
	const line = `  $ ${clip(input.command)}`;
	const tail = input.interactive
		? [
				"Do other independent work if you have any; otherwise END YOUR TURN now.",
				"The result wakes you when it finishes — don't sleep or check on it.",
			]
		: [
				"Headless run: nothing is delivered after this turn. Re-call",
				`${input.collectWith} id "${input.id}" until it reports finished.`,
			];
	return {
		text: [head, line, "", ...tail].join("\n"),
		details: {
			id: input.id,
			status: "running",
			background: true,
			auto: input.auto,
			retryable: true,
			pollRequired: !input.interactive,
			elapsedMs: input.elapsedMs,
		},
	};
}

export interface DeliveredJob {
	id: string;
	body: string;
}

/**
 * How finished background jobs introduce themselves when they arrive unasked.
 * Several jobs that finished during one agent run travel in a single message:
 * pi's follow-up queue is drained one message per turn by default, so one
 * message per job would cost a whole turn each.
 */
export function deliveryMessage(jobs: DeliveredJob[]): string {
	const blocks = jobs.map((job) =>
		[
			`<shell_bg_result id="${job.id}">`,
			job.body.trim(),
			`</shell_bg_result>`,
		].join("\n"),
	);
	const ids = jobs.map((job) => job.id).join(", ");
	const what = jobs.length === 1 ? "job" : "jobs";
	const intro = `${ids} — background ${what} finished, result${jobs.length === 1 ? "" : "s"} above.`;
	return [
		...blocks,
		"",
		intro,
		"Fold into your work; if you had moved on, say whether it changes anything.",
	].join("\n");
}

/** The custom-message type a delivered result travels under. */
export const DELIVERY_TYPE = "pi-utils-shell-bg-result";
