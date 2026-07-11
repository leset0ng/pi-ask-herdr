/**
 * Tool registration for ask_user.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isHerdrEnv, herdrNotify, setHerdrBlocked } from "./herdr.ts";
import { askInTui, renderAnswer } from "./ui.ts";
import type { AskDetails } from "./types.ts";

export function registerAskuserTool(pi: ExtensionAPI) {
	const OptionSchema = Type.Object({
		label: Type.String({ description: "Display label and returned value" }),
		description: Type.Optional(Type.String({ description: "Optional longer description shown in the menu" })),
	});

	const AskParamsSchema = Type.Object({
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
		timeout: Type.Optional(
			Type.Number({ description: "Optional timeout in milliseconds before auto-cancelling" }),
		),
		allow_custom: Type.Optional(
			Type.Boolean({
				description:
					"For confirm: also offer an 'Other (custom)' explain option. For select/multiselect it is always enabled.",
			}),
		),
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user an interactive question and wait for the answer. When you need a user response before continuing, you MUST call ask_user instead of asking in assistant text.",
		promptSnippet:
			"Request required user input in an interactive prompt; use ask_user instead of asking in chat.",
		promptGuidelines: [
			"Whenever you need the user to answer a question before you can continue, you MUST call ask_user; do not ask the question in assistant prose.",
			"Do not end a response with a question for the user when ask_user is available. Call ask_user and wait for its result.",
			"Use ask_user only for missing information, choices, or confirmation that cannot be inferred safely from the available context.",
			"For ask_user with type 'select' or 'multiselect', always provide the options array.",
			"Keep the ask_user question concise, but include enough decision context for the user to answer.",
			"Users can always choose 'Other (custom)' for select/multiselect to type their own answer.",
			"Use { label, description } objects for ask_user options when the user needs extra context to decide.",
		],
		parameters: AskParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			// Guard against non-interactive invocations.
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "ask_user can only be used in interactive TUI mode.",
						},
					],
					details: {
						question: params.question,
						type: params.type ?? "text",
						options: params.options,
						answer: null,
						cancelled: true,
					} satisfies AskDetails,
				};
			}

			// Validate select/multiselect input up front.
			if (
				(params.type === "select" || params.type === "multiselect") &&
				(!params.options || params.options.length === 0)
			) {
				return {
					content: [
						{
							type: "text",
							text: `ask_user error: type '${params.type}' requires an options array.`,
						},
					],
					details: {
						question: params.question,
						type: params.type,
						options: params.options,
						answer: null,
						cancelled: true,
					} satisfies AskDetails,
				};
			}

			// Tell Herdr that this pane is blocked waiting for input.
			if (isHerdrEnv()) {
				setHerdrBlocked(pi, true, "ask_user");
				await herdrNotify("Pi needs input", params.question);
			}

			const details = await askInTui(params, ctx);

			// Restore agent state now that the prompt is done.
			if (isHerdrEnv()) {
				setHerdrBlocked(pi, false);
			}

			return {
				content: [{ type: "text", text: renderAnswer(details) }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const question = typeof args.question === "string" ? args.question.trim() : "";
			let text = theme.fg("toolTitle", theme.bold("Ask User"));
			if (question) {
				text += ` ${theme.fg("muted", question)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
