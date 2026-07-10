/**
 * TUI prompting implementation for the ask_user tool.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskDetails, AskParams, AskType, OptionItem } from "./types.ts";
import { CUSTOM_LABEL } from "./types.ts";
import { formatOptionDisplay, normalizeOptions } from "./options.ts";

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
		ctx.ui.notify("ask_user: select requires options", "error");
		return {
			question: params.question,
			type: "select",
			options: rawOptions,
			answer: null,
			cancelled: true,
		};
	}

	const normalized = normalizeOptions(rawOptions);
	const items = normalized.map((o) => ({
		...o,
		display: formatOptionDisplay(o, ctx.ui.theme),
	}));
	const displayOptions = [...items.map((o) => o.display), CUSTOM_LABEL];
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

	const picked = items.find((o) => o.display === choice);
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
		ctx.ui.notify("ask_user: multiselect requires options", "error");
		return {
			question: params.question,
			type: "multiselect",
			options: rawOptions,
			answer: null,
			cancelled: true,
		};
	}

	const normalized = normalizeOptions(rawOptions);
	let optionItems: Array<OptionItem & { display: string }> = normalized.map((o) => ({
		...o,
		display: formatOptionDisplay(o, ctx.ui.theme),
	}));
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
					optionItems.push({
						label: text,
						value: text,
						display: text,
					});
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

export async function askInTui(params: AskParams, ctx: ExtensionContext): Promise<AskDetails> {
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

	const type: AskType = params.type ?? "text";
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

export function renderAnswer(details: AskDetails): string {
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
