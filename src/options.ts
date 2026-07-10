/**
 * Option normalization and display formatting for select / multiselect.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OptionItem, OptionObject } from "./types.ts";

export function normalizeOptions(options: (string | OptionObject)[]): OptionItem[] {
	return options.map((opt) => {
		if (typeof opt === "string") {
			return { label: opt, value: opt };
		}
		return { label: opt.label, value: opt.label, description: opt.description };
	});
}

/**
 * Bold the label when a description is present so described options stand out.
 */
export function formatOptionDisplay(
	item: OptionItem,
	theme: ExtensionContext["ui"]["theme"],
): string {
	if (!item.description) {
		return item.label;
	}
	return `${theme.bold(item.label)} — ${item.description}`;
}
