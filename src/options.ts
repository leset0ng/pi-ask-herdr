/**
 * Option normalization for select / multiselect.
 */

import type { OptionItem, OptionObject } from "./types.ts";

export function normalizeOptions(options: (string | OptionObject)[]): OptionItem[] {
	return options.map((opt) => {
		if (typeof opt === "string") {
			return { label: opt, value: opt };
		}
		return { label: opt.label, value: opt.label, description: opt.description };
	});
}
