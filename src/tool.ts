/**
 * Tool registration for ask_user.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clearAskMetadata, isHerdrEnv, reportAskMetadata, setHerdrBlocked } from "./herdr.ts";
import { askBatchInTui, renderAgentAnswer, renderBatchAnswer, renderSingleAnswer } from "./ui.ts";
import type { AskBatchDetails } from "./types.ts";

export function registerAskuserTool(pi: ExtensionAPI) {
	const OptionSchema = Type.Object({
		label: Type.String({ description: "Display label and returned value" }),
		description: Type.Optional(Type.String({ description: "Optional longer description shown in the menu" })),
	});

	const QuestionSchema = Type.Object({
		question: Type.String({
			description: "The exact question shown to the user; include the context needed to answer",
		}),
		type: Type.Optional(
			StringEnum(["text", "confirm", "select", "multiselect"] as const, {
				description: "Input type: text (default), confirm, select, or multiselect",
			}),
		),
		options: Type.Optional(
			Type.Array(Type.Union([Type.String(), OptionSchema]), {
				description: "Required when type is select or multiselect; items can be strings or {label, description?}",
			}),
		),
		default: Type.Optional(Type.String({ description: "Default value for text input" })),
		allow_custom: Type.Optional(
			Type.Boolean({
				description:
					"For confirm: also offer an 'Other (custom)' explain option. For select/multiselect it is always enabled.",
			}),
		),
	});

	const AskParamsSchema = Type.Object({
		questions: Type.Array(QuestionSchema, {
			minItems: 1,
			description:
				"Questions to ask, in order. The user answers them one by one and can step back with Esc. Use a single-element array for one question.",
		}),
		timeout: Type.Optional(
			Type.Number({ description: "Total timeout in milliseconds for the whole batch before auto-cancelling" }),
		),
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more interactive questions and wait for the answers. When you need a user response before continuing, you MUST call ask_user instead of asking in assistant text.",
		promptSnippet:
			"Request required user input in an interactive prompt; use ask_user instead of asking in chat.",
		promptGuidelines: [
			"Whenever you need the user to answer a question before you can continue, you MUST call ask_user; do not ask the question in assistant prose.",
			"Do not end a response with a question for the user when ask_user is available. Call ask_user and wait for its result.",
			"Use ask_user only for missing information, choices, or confirmation that cannot be inferred safely from the available context.",
			"Pass a single question as a one-element questions array; batch multiple related questions into one call so the user can answer them in sequence.",
			"For questions with type 'select' or 'multiselect', always provide the options array.",
			"Keep each question concise, but include enough decision context for the user to answer.",
			"Users can always choose 'Other (custom)' for select/multiselect to type their own answer.",
			"Use { label, description } objects for ask_user options when the user needs extra context to decide.",
		],
		parameters: AskParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const cancelledBatch = (): AskBatchDetails => ({ answers: [], cancelled: true });

			// Guard against non-interactive invocations.
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "ask_user can only be used in interactive TUI mode.",
						},
					],
					details: cancelledBatch(),
				};
			}

			// Validate all questions up front so the wizard never starts half-broken.
			const problems: string[] = [];
			params.questions.forEach((q, i) => {
				if (!q.question || !q.question.trim()) {
					problems.push(`questions[${i}]: question text is empty`);
				}
				if ((q.type === "select" || q.type === "multiselect") && (!q.options || q.options.length === 0)) {
					problems.push(`questions[${i}]: type '${q.type}' requires a non-empty options array`);
				}
			});
			if (problems.length > 0) {
				return {
					content: [{ type: "text", text: `ask_user error:\n${problems.join("\n")}` }],
					details: cancelledBatch(),
				};
			}

			// Tell Herdr that this pane is blocked waiting for input, and
			// surface the pending question(s) in the sidebar.
			if (isHerdrEnv()) {
				setHerdrBlocked(pi, true, "ask_user");
				await reportAskMetadata(params.questions.map((q) => q.question.trim()));
			}

			let details: AskBatchDetails;
			try {
				details = await askBatchInTui(params, ctx, signal ?? undefined);
			} finally {
				// Restore agent state and clear the sidebar token.
				if (isHerdrEnv()) {
					setHerdrBlocked(pi, false);
					await clearAskMetadata();
				}
			}

			return {
				content: [{ type: "text", text: renderAgentAnswer(details) }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const count = questions.length;
			let text = theme.fg("toolTitle", theme.bold(count > 1 ? `Ask User (${count} questions)` : "Ask User"));
			if (count === 1) {
				const question = typeof questions[0]?.question === "string" ? questions[0].question.trim() : "";
				if (question) text += ` ${theme.fg("muted", question)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as AskBatchDetails | undefined;
			const textContent = result.content.find((item) => item.type === "text");
			const rawText = textContent?.type === "text" ? textContent.text : "";
			const questions = Array.isArray(context.args.questions) ? context.args.questions : [];
			const isSingle = questions.length === 1;

			if (!details || (details.cancelled && rawText !== "User cancelled the prompt.")) {
				return new Text(rawText, 0, 0);
			}
			if (details.cancelled) {
				return new Text(isSingle ? rawText : theme.fg("warning", "Cancelled"), 0, 0);
			}
			if (isSingle && details.answers[0]) {
				return new Text(renderSingleAnswer(details.answers[0]), 0, 0);
			}
			return new Text(renderBatchAnswer(details), 0, 0);
		},
	});
}
