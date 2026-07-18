/**
 * TUI prompting implementation for the ask_user tool.
 *
 * All questions run inside a single ctx.ui.custom() wizard component:
 * - Enter submits and advances to the next question
 * - Esc steps back one layer (custom input -> question -> previous question)
 * - Ctrl+C cancels the whole batch immediately, discarding all answers
 */

import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { normalizeOptions } from "./options.ts";
import type { AskBatchDetails, AskDetails, AskParams, AskType, OptionItem } from "./types.ts";
import { CUSTOM_LABEL, CUSTOM_SENTINEL } from "./types.ts";

/** Wrap text while keeping the first-line prefix and aligning continuations. */
function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
	const renderWidth = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = renderWidth - prefixWidth;

	// A CJK grapheme needs two columns. On extremely narrow layouts, put a
	// meaningful prefix on its own line and give the content the full width.
	if (contentWidth < 2) {
		const compactPrefix = prefix.trimEnd();
		const wrapped = wrapTextWithAnsi(text, renderWidth);
		return compactPrefix ? [truncateToWidth(compactPrefix, renderWidth, ""), ...wrapped] : wrapped;
	}

	const wrapped = wrapTextWithAnsi(text, contentWidth);
	const continuationPrefix = " ".repeat(prefixWidth);
	return wrapped.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`);
}

interface OptionListItem extends OptionItem {
	isCustom?: boolean;
}

interface QuestionState {
	question: string;
	type: AskType;
	options: AskDetails["options"];
	/** Normalized items for select/multiselect; grows when custom values are added. */
	items: OptionItem[];
	answer: string | boolean | string[] | undefined;
	custom?: boolean;
	/** Live selection set for multiselect; shared with the OptionList. */
	selected: Set<string>;
}

/**
 * Shared wrapped option list for select, confirm, and multiselect questions.
 * Navigation remains item-based even when one item occupies several lines.
 */
class OptionList {
	private cursor = 0;
	private maxVisibleItems: number;

	onSelect?: (item: OptionListItem) => void;
	onDone?: () => void;
	onBack?: () => void;
	onCustom?: () => void;

	constructor(
		private items: OptionListItem[],
		private mode: "select" | "multiselect",
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private selected: Set<string> = new Set<string>(),
		maxVisibleItems = 10,
		private maxVisibleLines = 12,
	) {
		this.maxVisibleItems = Math.max(1, Math.min(items.length, maxVisibleItems));
	}

	setSelectedIndex(index: number): void {
		this.cursor = Math.max(0, Math.min(index, this.items.length - 1));
	}

	private currentItem(): OptionListItem | undefined {
		return this.items[this.cursor];
	}

	private toggle(): void {
		const item = this.currentItem();
		if (!item || item.isCustom) return;
		if (this.selected.has(item.value)) {
			this.selected.delete(item.value);
		} else {
			this.selected.add(item.value);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = this.cursor === 0 ? this.items.length - 1 : this.cursor - 1;
		} else if (matchesKey(data, "down") || this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = this.cursor === this.items.length - 1 ? 0 : this.cursor + 1;
		} else if (matchesKey(data, "space") && this.mode === "multiselect") {
			if (this.currentItem()?.isCustom) this.onCustom?.();
			else this.toggle();
		} else if (matchesKey(data, "enter") || this.keybindings.matches(data, "tui.select.confirm")) {
			const item = this.currentItem();
			if (!item) return;
			if (item.isCustom) this.onCustom?.();
			else if (this.mode === "multiselect") this.onDone?.();
			else this.onSelect?.(item);
		} else if (matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.onBack?.();
		}
	}

	private renderItem(item: OptionListItem, index: number, width: number): string[] {
		const rows: string[] = [];
		const isCursor = index === this.cursor;
		const pointer = isCursor ? this.theme.fg("accent", "›") : " ";
		const marker =
			this.mode === "multiselect"
				? item.isCustom
					? "   "
					: this.selected.has(item.value)
						? "[x]"
						: "[ ]"
				: "";
		const prefix = this.mode === "multiselect" ? `${pointer} ${marker} ` : `${pointer} `;
		const label = item.isCustom
			? this.theme.fg(isCursor ? "accent" : "dim", item.label)
			: isCursor
				? this.theme.fg("accent", item.label)
				: item.label;
		rows.push(...wrapWithPrefix(prefix, label, width));

		if (item.description) {
			const descriptionPrefix = " ".repeat(visibleWidth(prefix));
			rows.push(...wrapWithPrefix(descriptionPrefix, this.theme.fg("muted", item.description), width));
		}
		return rows;
	}

	private visibleRange(renderedItems: string[][]): { start: number; end: number } {
		if (renderedItems.length === 0) return { start: 0, end: 0 };

		let start = this.cursor;
		let end = this.cursor + 1;
		let visibleLines = renderedItems[this.cursor]?.length ?? 0;

		while (end - start < this.maxVisibleItems) {
			const before = start - 1;
			const after = end;
			const beforeCount = this.cursor - start;
			const afterCount = end - this.cursor - 1;
			const candidates = beforeCount <= afterCount ? [before, after] : [after, before];
			let added = false;

			for (const candidate of candidates) {
				if (candidate < 0 || candidate >= renderedItems.length || (candidate >= start && candidate < end)) continue;
				const candidateLines = renderedItems[candidate]?.length ?? 0;
				if (visibleLines + candidateLines > this.maxVisibleLines) continue;
				if (candidate === start - 1) start--;
				else if (candidate === end) end++;
				else continue;
				visibleLines += candidateLines;
				added = true;
				break;
			}
			if (!added) break;
		}
		return { start, end };
	}

	render(width: number): string[] {
		const rows: string[] = [];
		const renderedItems = this.items.map((item, index) => this.renderItem(item, index, width));
		const { start, end } = this.visibleRange(renderedItems);

		if (start > 0) rows.push(this.theme.fg("dim", truncateToWidth(`  ↑ ${start} more`, width, "")));
		for (let i = start; i < end; i++) {
			rows.push(...(renderedItems[i] ?? []));
		}
		if (end < this.items.length) {
			rows.push(this.theme.fg("dim", truncateToWidth(`  ↓ ${this.items.length - end} more`, width, "")));
		}
		return rows;
	}

	invalidate(): void {
		// Rendered from current state each frame; nothing cached.
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
	private child: OptionList | Input;
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
		private keybindings: KeybindingsManager,
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

	private buildChild(): OptionList | Input {
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
				const items: OptionListItem[] = [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				];
				if (this.params.questions[this.index].allow_custom) {
					items.push({ value: CUSTOM_SENTINEL, label: CUSTOM_LABEL, isCustom: true });
				}
				const list = new OptionList(items, "select", this.theme, this.keybindings);
				if (state.answer === true) list.setSelectedIndex(0);
				else if (state.answer === false) list.setSelectedIndex(1);
				list.onSelect = (item) => {
					state.answer = item.value === "yes";
					state.custom = false;
					this.advance();
				};
				list.onCustom = () => this.enterCustomMode();
				list.onBack = () => this.back();
				return list;
			}

			case "select": {
				const items: OptionListItem[] = [
					...state.items.map((i) => ({ value: i.value, label: i.label, description: i.description })),
					{ value: CUSTOM_SENTINEL, label: CUSTOM_LABEL, isCustom: true },
				];
				const list = new OptionList(items, "select", this.theme, this.keybindings);
				if (typeof state.answer === "string" && !state.custom) {
					const prevIndex = state.items.findIndex((i) => i.value === state.answer);
					if (prevIndex >= 0) list.setSelectedIndex(prevIndex);
				}
				list.onSelect = (item) => {
					state.answer = item.value;
					state.custom = false;
					this.advance();
				};
				list.onCustom = () => this.enterCustomMode();
				list.onBack = () => this.back();
				return list;
			}

			case "multiselect": {
				const items: OptionListItem[] = [
					...state.items.map((i) => ({ value: i.value, label: i.label, description: i.description })),
					{ value: CUSTOM_SENTINEL, label: CUSTOM_LABEL, isCustom: true },
				];
				const list = new OptionList(items, "multiselect", this.theme, this.keybindings, state.selected);
				list.onDone = () => {
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
		const padding = width >= 3 ? " " : "";
		const bodyWidth = Math.max(1, width - visibleWidth(padding));

		lines.push(this.borderLine(width));
		if (this.states.length > 1) {
			lines.push(this.headerLine(width));
			lines.push("");
		}
		lines.push(...wrapWithPrefix(padding, this.theme.bold(state.question), width));
		lines.push("");
		const body = this.mode === "custom" ? this.customInput!.render(bodyWidth) : this.child.render(bodyWidth);
		for (const bl of body) lines.push(`${padding}${bl}`);
		lines.push("");
		lines.push(...wrapWithPrefix(padding, this.helpLine(), width));
		lines.push(this.borderLine(width));

		return lines.map((line) => truncateToWidth(line, width));
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
		(tui, theme, keybindings, done) => new AskWizard(params, tui, theme, keybindings, done, signal),
	);
	if (!result) {
		return { answers: [], cancelled: true };
	}
	return { answers: result, cancelled: false };
}

function singleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function formatAnswer(details: AskDetails, annotateCustom: boolean): string {
	if (details.answer === null) return "(no answer)";
	if (typeof details.answer === "boolean") return details.answer ? "yes" : "no";
	if (Array.isArray(details.answer)) {
		return details.answer.length > 0 ? details.answer.map(singleLine).join(", ") : "(nothing selected)";
	}
	const answer = singleLine(details.answer);
	return annotateCustom && details.custom ? `(custom) ${answer}` : answer;
}

/** Compact content returned to the agent. Questions remain available in details. */
export function renderAgentAnswer(details: AskBatchDetails): string {
	if (details.cancelled) {
		return "User cancelled the prompt.";
	}
	return details.answers.map((answer, index) => `${index + 1} -> ${formatAnswer(answer, false)}`).join("\n");
}

/** Answer-only result text used by the single-question tool UI. */
export function renderSingleAnswer(details: AskDetails): string {
	if (details.cancelled) return "User cancelled the prompt.";
	return formatAnswer(details, false);
}

/** Detailed content rendered in the multi-question tool UI for the user. */
export function renderBatchAnswer(details: AskBatchDetails): string {
	if (details.cancelled) {
		return "User cancelled the prompt.";
	}
	return details.answers
		.map((answer, index) => `${index + 1}. ${answer.question} → ${formatAnswer(answer, true)}`)
		.join("\n");
}
