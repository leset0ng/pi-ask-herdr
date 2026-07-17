/**
 * TUI prompting implementation for the ask_user tool.
 *
 * All questions run inside a single ctx.ui.custom() wizard component:
 * - Enter submits and advances to the next question
 * - Esc steps back one layer (custom input -> question -> previous question)
 * - Ctrl+C cancels the whole batch immediately, discarding all answers
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { normalizeOptions } from "./options.ts";
import type { AskBatchDetails, AskDetails, AskParams, AskType, OptionItem } from "./types.ts";
import { CUSTOM_LABEL, CUSTOM_SENTINEL } from "./types.ts";

function selectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	};
}

/** Greedy word wrap that respects ANSI escape sequences. */
function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (visibleWidth(para) <= width) {
			out.push(para);
			continue;
		}
		let line = "";
		for (const word of para.split(" ")) {
			const candidate = line ? `${line} ${word}` : word;
			if (visibleWidth(candidate) <= width) {
				line = candidate;
			} else {
				if (line) out.push(line);
				line = word;
			}
		}
		if (line) out.push(line);
	}
	return out.length > 0 ? out : [""];
}

interface QuestionState {
	question: string;
	type: AskType;
	options: AskDetails["options"];
	/** Normalized items for select/multiselect; grows when custom values are added. */
	items: OptionItem[];
	answer: string | boolean | string[] | undefined;
	custom?: boolean;
	/** Live selection set for multiselect; shared with the CheckboxList. */
	selected: Set<string>;
}

/**
 * Checkbox list for multiselect questions.
 * Space toggles the focused row, Enter submits (or opens the custom input
 * when the custom row is focused), Esc goes back.
 */
class CheckboxList {
	private cursor = 0;
	private maxVisible: number;

	onSubmit?: () => void;
	onBack?: () => void;
	onCustom?: () => void;

	constructor(
		private items: OptionItem[],
		private selected: Set<string>,
		private theme: Theme,
	) {
		this.maxVisible = Math.min(this.rowCount(), 10);
	}

	private rowCount(): number {
		return this.items.length + 1; // +1 for the custom row
	}

	private onCustomRow(): boolean {
		return this.cursor === this.items.length;
	}

	private toggle() {
		const item = this.items[this.cursor];
		if (!item) return;
		if (this.selected.has(item.value)) {
			this.selected.delete(item.value);
		} else {
			this.selected.add(item.value);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.cursor = this.cursor === 0 ? this.rowCount() - 1 : this.cursor - 1;
		} else if (matchesKey(data, "down")) {
			this.cursor = this.cursor === this.rowCount() - 1 ? 0 : this.cursor + 1;
		} else if (matchesKey(data, "space")) {
			if (this.onCustomRow()) this.onCustom?.();
			else this.toggle();
		} else if (matchesKey(data, "enter")) {
			if (this.onCustomRow()) this.onCustom?.();
			else this.onSubmit?.();
		} else if (matchesKey(data, "escape")) {
			this.onBack?.();
		}
	}

	render(width: number): string[] {
		const rows: string[] = [];
		const total = this.rowCount();
		const start = Math.max(0, Math.min(this.cursor - Math.floor(this.maxVisible / 2), total - this.maxVisible));
		const end = Math.min(total, start + this.maxVisible);

		if (start > 0) rows.push(this.theme.fg("dim", `  ↑ ${start} more`));
		for (let i = start; i < end; i++) {
			const isCursor = i === this.cursor;
			const pointer = isCursor ? "›" : " ";
			if (i < this.items.length) {
				const item = this.items[i];
				const box = this.selected.has(item.value) ? "[x]" : "[ ]";
				const desc = item.description ? this.theme.fg("muted", ` — ${item.description}`) : "";
				const line = `${pointer} ${box} ${item.label}${desc}`;
				rows.push(isCursor ? this.theme.fg("accent", line) : line);
			} else {
				const line = `${pointer}     ${CUSTOM_LABEL}`;
				rows.push(isCursor ? this.theme.fg("accent", line) : this.theme.fg("dim", line));
			}
		}
		if (end < total) rows.push(this.theme.fg("dim", `  ↓ ${total - end} more`));

		return rows.map((r) => truncateToWidth(r, width));
	}
}

/**
 * The batch wizard. Owns the question queue, per-question child widgets,
 * layered Esc handling, and the batch timeout.
 */
class AskWizard {
	private states: QuestionState[];
	private index = 0;
	private mode: "question" | "custom" = "question";
	private child: SelectList | CheckboxList | Input;
	private customInput: Input | null = null;
	private finished = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private deadline: number | undefined;
	private abortListener: (() => void) | undefined;

	constructor(
		private params: AskParams,
		private tui: TUI,
		private theme: Theme,
		private doneCb: (result: AskDetails[] | null) => void,
		private abortSignal?: AbortSignal,
	) {
		this.states = params.questions.map((q) => ({
			question: q.question.trim(),
			type: q.type ?? "text",
			options: q.options,
			items: normalizeOptions(q.options ?? []),
			answer: undefined,
			selected: new Set<string>(),
		}));
		this.child = this.buildChild();

		if (params.timeout && params.timeout > 0) {
			this.deadline = Date.now() + params.timeout;
			this.timer = setTimeout(() => this.finish(null), params.timeout);
			this.ticker = setInterval(() => this.tui.requestRender(), 1000);
		}
		if (abortSignal) {
			this.abortListener = () => this.finish(null);
			abortSignal.addEventListener("abort", this.abortListener);
		}
	}

	private get current(): QuestionState {
		return this.states[this.index];
	}

	private buildChild(): SelectList | CheckboxList | Input {
		const state = this.current;

		switch (state.type) {
			case "text": {
				const input = new Input();
				input.focused = true;
				const fallback = this.params.questions[this.index].default ?? "";
				input.setValue(typeof state.answer === "string" ? state.answer : fallback);
				input.onSubmit = (value) => {
					state.answer = value;
					state.custom = false;
					this.advance();
				};
				input.onEscape = () => this.back();
				return input;
			}

			case "confirm": {
				const items: SelectItem[] = [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				];
				if (this.params.questions[this.index].allow_custom) {
					items.push({ value: CUSTOM_SENTINEL, label: CUSTOM_LABEL });
				}
				const list = new SelectList(items, items.length, selectTheme(this.theme));
				if (state.answer === true) list.setSelectedIndex(0);
				else if (state.answer === false) list.setSelectedIndex(1);
				list.onSelect = (item) => {
					if (item.value === CUSTOM_SENTINEL) {
						this.enterCustomMode();
					} else {
						state.answer = item.value === "yes";
						state.custom = false;
						this.advance();
					}
				};
				list.onCancel = () => this.back();
				return list;
			}

			case "select": {
				const items: SelectItem[] = [
					...state.items.map((i) => ({ value: i.value, label: i.label, description: i.description })),
					{ value: CUSTOM_SENTINEL, label: CUSTOM_LABEL },
				];
				const list = new SelectList(items, Math.min(items.length, 10), selectTheme(this.theme));
				if (typeof state.answer === "string" && !state.custom) {
					const prevIndex = state.items.findIndex((i) => i.value === state.answer);
					if (prevIndex >= 0) list.setSelectedIndex(prevIndex);
				}
				list.onSelect = (item) => {
					if (item.value === CUSTOM_SENTINEL) {
						this.enterCustomMode();
					} else {
						state.answer = item.value;
						state.custom = false;
						this.advance();
					}
				};
				list.onCancel = () => this.back();
				return list;
			}

			case "multiselect": {
				const list = new CheckboxList(state.items, state.selected, this.theme);
				list.onSubmit = () => {
					state.answer = Array.from(state.selected);
					state.custom = false;
					this.advance();
				};
				list.onBack = () => this.back();
				list.onCustom = () => this.enterCustomMode();
				return list;
			}
		}
	}

	private enterCustomMode() {
		this.mode = "custom";
		const input = new Input();
		input.focused = true;
		this.customInput = input;
		input.onSubmit = (value) => {
			const text = value.trim();
			if (!text) {
				this.exitCustomMode();
				return;
			}
			const state = this.current;
			if (state.type === "multiselect") {
				if (!state.items.some((i) => i.value === text)) {
					state.items.push({ label: text, value: text });
				}
				state.selected.add(text);
				this.exitCustomMode();
			} else {
				state.answer = text;
				state.custom = true;
				this.advance();
			}
		};
		input.onEscape = () => this.exitCustomMode();
	}

	private exitCustomMode() {
		this.mode = "question";
		this.customInput = null;
		this.child = this.buildChild();
	}

	private advance() {
		this.mode = "question";
		this.customInput = null;
		if (this.index === this.states.length - 1) {
			this.finish(this.buildDetails());
			return;
		}
		this.index++;
		this.child = this.buildChild();
	}

	private back() {
		if (this.mode === "custom") {
			this.exitCustomMode();
			return;
		}
		if (this.index === 0) return; // Nowhere to go; help line points at Ctrl+C.
		this.index--;
		this.child = this.buildChild();
	}

	private buildDetails(): AskDetails[] {
		return this.states.map((s) => ({
			question: s.question,
			type: s.type,
			options: s.options,
			answer: s.answer ?? null,
			cancelled: false,
			custom: s.custom,
		}));
	}

	private finish(result: AskDetails[] | null) {
		if (this.finished) return;
		this.finished = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.ticker) clearInterval(this.ticker);
		if (this.abortListener && this.abortSignal) {
			this.abortSignal.removeEventListener("abort", this.abortListener);
		}
		this.doneCb(result);
	}

	dispose() {
		if (this.timer) clearTimeout(this.timer);
		if (this.ticker) clearInterval(this.ticker);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		// Ctrl+C cancels the whole batch no matter which layer has focus.
		// (SelectList/Input map escape AND ctrl+c to their cancel hooks, so
		// ctrl+c must be intercepted here before delegating.)
		if (matchesKey(data, "ctrl+c")) {
			this.finish(null);
			return;
		}
		if (this.mode === "custom") {
			this.customInput?.handleInput(data);
		} else {
			this.child.handleInput(data);
		}
		this.tui.requestRender();
	}

	private borderLine(width: number): string {
		return this.theme.fg("accent", "─".repeat(Math.max(1, width)));
	}

	private headerLine(width: number): string {
		const label = ` Question ${this.index + 1}/${this.states.length}`;
		const barWidth = Math.max(5, Math.min(20, width - visibleWidth(label) - 3));
		const filled = Math.round(((this.index + 1) / this.states.length) * barWidth);
		const bar =
			this.theme.fg("accent", this.theme.bold("━".repeat(filled))) +
			this.theme.fg("dim", "─".repeat(barWidth - filled));
		return `${label}  ${bar}`;
	}

	private helpLine(): string {
		const parts: string[] = [];
		if (this.mode === "custom") {
			parts.push("enter submit");
		} else {
			switch (this.current.type) {
				case "text":
					parts.push("enter submit");
					break;
				case "confirm":
				case "select":
					parts.push("↑↓ move", "enter select");
					break;
				case "multiselect":
					parts.push("↑↓ move", "space toggle", "enter done");
					break;
			}
		}
		if (this.mode === "custom" || this.index > 0) {
			parts.push("esc back");
		}
		parts.push("^C cancel");
		if (this.deadline) {
			const remaining = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
			parts.push(`${remaining}s`);
		}
		return this.theme.fg("dim", parts.join(" · "));
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const state = this.current;
		const bodyWidth = Math.max(1, width - 2);

		lines.push(this.borderLine(width));
		if (this.states.length > 1) {
			lines.push(this.headerLine(width));
			lines.push("");
		}
		for (const ql of wrapText(state.question, bodyWidth)) {
			lines.push(` ${this.theme.bold(ql)}`);
		}
		lines.push("");
		const body = this.mode === "custom" ? this.customInput!.render(bodyWidth) : this.child.render(bodyWidth);
		for (const bl of body) lines.push(` ${bl}`);
		lines.push("");
		lines.push(` ${this.helpLine()}`);
		lines.push(this.borderLine(width));

		return lines.map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		// Rendered from scratch each frame; nothing cached.
	}
}

export async function askBatchInTui(
	params: AskParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AskBatchDetails> {
	const result = await ctx.ui.custom<AskDetails[] | null>(
		(tui, theme, _keybindings, done) => new AskWizard(params, tui, theme, done, signal),
	);
	if (!result) {
		return { answers: [], cancelled: true };
	}
	return { answers: result, cancelled: false };
}

function formatAnswer(details: AskDetails): string {
	if (details.answer === null) return "(no answer)";
	if (typeof details.answer === "boolean") return details.answer ? "yes" : "no";
	if (Array.isArray(details.answer)) {
		return details.answer.length > 0 ? details.answer.join(", ") : "(nothing selected)";
	}
	return details.custom ? `(custom) ${details.answer}` : details.answer;
}

export function renderBatchAnswer(details: AskBatchDetails): string {
	if (details.cancelled) {
		return "User cancelled the prompt.";
	}
	return details.answers.map((d, i) => `${i + 1}. ${d.question} → ${formatAnswer(d)}`).join("\n");
}
