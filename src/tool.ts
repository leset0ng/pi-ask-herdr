/**
 * Tool registration for askuser.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
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
		question: Type.String({ description: "The question to ask the user" }),
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
		name: "askuser",
		label: "Ask User",
		description:
			"Ask the user a question and wait for an answer. Use when you need user input to continue.",
		promptSnippet: "Prompt the user for input when the next step depends on a choice or missing detail.",
		promptGuidelines: [
			"Use askuser only when the task cannot proceed without user input.",
			"For askuser with type 'select' or 'multiselect', always provide the options array.",
			"Keep the question concise but include enough context for the user to answer.",
			"Users can always choose 'Other (custom)' for select/multiselect to type their own answer.",
			"Use { label, description } objects for options when the user needs extra context to decide.",
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
							text: "askuser can only be used in interactive TUI mode.",
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
							text: `askuser error: type '${params.type}' requires an options array.`,
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
				setHerdrBlocked(pi, true, "askuser");
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
	});
}
