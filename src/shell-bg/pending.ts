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
				"Its result is delivered here automatically when it finishes — it wakes you, so you",
				`do not need to poll ${input.collectWith} for it. Carry on with other work; call`,
				`${input.collectWith} with id "${input.id}" only if you want it early, and`,
				`${input.collectWith} with no id lists everything still running.`,
			]
		: [
				"This is a headless run: nothing is delivered after your turn ends. Call",
				`${input.collectWith} with id "${input.id}" again in this same turn until it reports finished —`,
				"do not end your turn expecting the result to arrive on its own.",
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
	const intro =
		jobs.length === 1
			? `This is ${ids}, a command you sent to the background; it has just finished and this is its result.`
			: `These are ${ids}, commands you sent to the background; they have finished and these are their results.`;
	return [
		...blocks,
		"",
		intro,
		"This is the background wake-up — it arrives on its own, so you never need to poll",
		"shell_status to keep waiting on a background job; still-running jobs will wake you",
		"the same way when they finish. Fold this into what you are doing;",
		"if you had already moved on, say what it changes — or that it changes nothing.",
	].join("\n");
}

/** The custom-message type a delivered result travels under. */
export const DELIVERY_TYPE = "pi-utils-shell-bg-result";
