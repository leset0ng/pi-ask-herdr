/**
 * pi-ask-herdr
 *
 * A Pi extension that adds an `askuser` tool so the agent can ask the user
 * for input when it needs a decision to proceed.
 *
 * When Pi runs inside a Herdr pane, the extension also:
 *   - reports the pane agent state as `blocked` while waiting for an answer
 *     via the official Herdr Pi integration event bus (`herdr:blocked`)
 *   - sends a Herdr toast notification so the user knows input is needed
 *   - restores the agent state after the user answers
 *
 * Supported prompt types:
 *   - text       free-form text input
 *   - confirm    yes / no (with optional "Other (custom)" explain option)
 *   - select     single choice, always offers "Other (custom)" fallback
 *   - multiselect multiple choices, always offers "Other (custom)" fallback
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createConnection } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AskType = "text" | "confirm" | "select" | "multiselect";

interface OptionObject {
	label: string;
	description?: string;
}

interface AskParams {
	question: string;
	type?: AskType;
	options?: (string | OptionObject)[];
	default?: string;
	timeout?: number;
	allow_custom?: boolean;
}

interface NormalizedOption {
	label: string;
	value: string;
	display: string;
	description?: string;
}

interface AskDetails {
	question: string;
	type: AskType;
	options: (string | OptionObject)[] | undefined;
	answer: string | boolean | string[] | null;
	cancelled: boolean;
	custom?: boolean;
}

// Sentinel value used internally for the "Other (custom)" menu item.
const CUSTOM_SENTINEL = "__askuser_custom__";
const CUSTOM_LABEL = "✎ Other (custom)";

function normalizeOptions(options: (string | OptionObject)[]): NormalizedOption[] {
	return options.map((opt) => {
		if (typeof opt === "string") {
			return { label: opt, value: opt, display: opt };
		}
		const display = opt.description ? `${opt.label} — ${opt.description}` : opt.label;
		return { label: opt.label, value: opt.label, display, description: opt.description };
	});
}

// ---------------------------------------------------------------------------
// Herdr integration helpers
// ---------------------------------------------------------------------------

function isHerdrEnv(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

function herdrSocketPath(): string | undefined {
	return process.env.HERDR_SOCKET_PATH;
}

/**
 * Send a single JSON-RPC-style request to the Herdr Unix socket and return
 * the matching result. Herdr speaks newline-delimited JSON.
 */
function herdrRequest<T>(method: string, params: object): Promise<T | undefined> {
	const socketPath = herdrSocketPath();
	if (!socketPath) return Promise.resolve(undefined);

	const id = `askuser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	return new Promise<T | undefined>((resolve, reject) => {
		let buffer = "";
		const client = createConnection(socketPath);

		const timer = setTimeout(() => {
			client.end();
			reject(new Error("herdr socket timeout"));
		}, 5000);

		client.on("connect", () => {
			client.write(JSON.stringify({ id, method, params }) + "\n");
		});

		client.on("data", (data) => {
			buffer += data.toString("utf8");
		});

		client.on("end", () => {
			clearTimeout(timer);
			const lines = buffer
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);

			for (const line of lines) {
				try {
					const msg = JSON.parse(line) as { id?: string; result?: T; error?: { message: string } };
					if (msg.id === id) {
						if (msg.error) {
							reject(new Error(msg.error.message));
						} else {
							resolve(msg.result);
						}
						return;
					}
				} catch {
					// ignore malformed lines
				}
			}
			resolve(undefined);
		});

		client.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

async function herdrNotify(title: string, body: string) {
	try {
		await herdrRequest<{ type: string; shown: boolean; reason?: string }>("notification.show", {
			title,
			body,
			sound: "request",
		});
	} catch (err) {
		console.error("[pi-ask-herdr] notification.show failed:", err);
	}
}

function setHerdrBlocked(pi: ExtensionAPI, active: boolean, label?: string) {
	try {
		pi.events.emit("herdr:blocked", { active, label });
	} catch (err) {
		console.error("[pi-ask-herdr] failed to emit herdr:blocked:", err);
	}
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function makeSignal(timeout?: number): AbortSignal | undefined {
	if (!timeout || timeout <= 0) return undefined;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeout);
	return controller.signal;
}

async function askText(params: AskParams, ctx: ExtensionContext): Promise<AskDetails> {
	const signal = makeSignal(params.timeout);
	const text = await ctx.ui.input(params.question, params.default ?? "", signal ? { signal } : undefined);
	return {
		question: params.question,
		type: "text",
		options: undefined,
		answer: text ?? null,
		cancelled: text === null,
	};
}

async function askConfirm(params: AskParams, ctx: ExtensionContext): Promise<AskDetails> {
	const signal = makeSignal(params.timeout);
	const allowCustom = params.allow_custom ?? false;

	if (!allowCustom) {
		const ok = await ctx.ui.confirm(params.question, undefined, signal ? { signal } : undefined);
		return {
			question: params.question,
			type: "confirm",
			options: undefined,
			answer: ok === null ? null : ok,
			cancelled: ok === null,
		};
	}

	const options = ["Yes", "No", CUSTOM_LABEL];
	const choice = await ctx.ui.select(params.question, options, signal ? { signal } : undefined);

	if (choice === null) {
		return {
			question: params.question,
			type: "confirm",
			options: undefined,
			answer: null,
			cancelled: true,
		};
	}

	if (choice === CUSTOM_LABEL) {
		const text = await ctx.ui.input("Please explain your choice:");
		return {
			question: params.question,
			type: "confirm",
			options: undefined,
			answer: text ?? null,
			cancelled: text === null,
			custom: true,
		};
	}

	return {
		question: params.question,
		type: "confirm",
		options: undefined,
		answer: choice === "Yes",
		cancelled: false,
	};
}

async function askSelect(params: AskParams, ctx: ExtensionContext): Promise<AskDetails> {
	const rawOptions = params.options ?? [];
	if (rawOptions.length === 0) {
		ctx.ui.notify("askuser: select requires options", "error");
		return {
			question: params.question,
			type: "select",
			options: rawOptions,
			answer: null,
			cancelled: true,
		};
	}

	const normalized = normalizeOptions(rawOptions);
	const displayOptions = [...normalized.map((o) => o.display), CUSTOM_LABEL];
	const choice = await ctx.ui.select(params.question, displayOptions);

	if (choice === null) {
		return {
			question: params.question,
			type: "select",
			options: rawOptions,
			answer: null,
			cancelled: true,
		};
	}

	if (choice === CUSTOM_LABEL) {
		const text = await ctx.ui.input("Enter your custom answer:");
		return {
			question: params.question,
			type: "select",
			options: rawOptions,
			answer: text ?? null,
			cancelled: text === null,
			custom: true,
		};
	}

	const picked = normalized.find((o) => o.display === choice);
	return {
		question: params.question,
		type: "select",
		options: rawOptions,
		answer: picked?.value ?? choice,
		cancelled: false,
	};
}

async function askMultiselect(params: AskParams, ctx: ExtensionContext): Promise<AskDetails> {
	const rawOptions = params.options ?? [];
	if (rawOptions.length === 0) {
		ctx.ui.notify("askuser: multiselect requires options", "error");
		return {
			question: params.question,
			type: "multiselect",
			options: rawOptions,
			answer: null,
			cancelled: true,
		};
	}

	const normalized = normalizeOptions(rawOptions);
	const optionItems = [...normalized];
	const selected = new Set<string>();

	while (true) {
		const displayOptions: string[] = ["✓ Done", "✗ Cancel", CUSTOM_LABEL];
		for (const item of optionItems) {
			const prefix = selected.has(item.value) ? "[x]" : "[ ]";
			displayOptions.push(`${prefix} ${item.display}`);
		}

		const choice = await ctx.ui.select(params.question, displayOptions);

		if (choice === null || choice === "✗ Cancel") {
			return {
				question: params.question,
				type: "multiselect",
				options: rawOptions,
				answer: null,
				cancelled: true,
			};
		}

		if (choice === "✓ Done") {
			return {
				question: params.question,
				type: "multiselect",
				options: rawOptions,
				answer: Array.from(selected),
				cancelled: false,
			};
		}

		if (choice === CUSTOM_LABEL) {
			const text = await ctx.ui.input("Enter a custom value to add:");
			if (text) {
				if (!optionItems.some((i) => i.value === text)) {
					optionItems.push({ label: text, value: text, display: text });
				}
				selected.add(text);
			}
			continue;
		}

		// Toggle a regular option.
		const display = choice.replace(/^\[[x ]\] /, "");
		const item = optionItems.find((i) => i.display === display);
		const value = item?.value ?? display;
		if (selected.has(value)) {
			selected.delete(value);
		} else {
			selected.add(value);
		}
	}
}

async function askInTui(params: AskParams, ctx: ExtensionContext): Promise<AskDetails> {
	const question = params.question.trim();
	if (!question) {
		return {
			question: "",
			type: params.type ?? "text",
			options: params.options,
			answer: null,
			cancelled: true,
		};
	}

	const type = params.type ?? "text";
	switch (type) {
		case "confirm":
			return askConfirm(params, ctx);
		case "select":
			return askSelect(params, ctx);
		case "multiselect":
			return askMultiselect(params, ctx);
		case "text":
		default:
			return askText(params, ctx);
	}
}

function renderAnswer(details: AskDetails): string {
	if (details.cancelled) {
		return "User cancelled the prompt.";
	}
	if (details.answer === null) {
		return "No answer provided.";
	}
	if (typeof details.answer === "boolean") {
		return details.answer ? "User answered yes." : "User answered no.";
	}
	if (Array.isArray(details.answer)) {
		if (details.answer.length === 0) return "User selected nothing.";
		return `User selected: ${details.answer.join(", ")}`;
	}
	return `User answered: ${details.answer}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function askuserHerdr(pi: ExtensionAPI) {
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
