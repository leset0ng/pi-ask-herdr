/**
 * Shared types for the pi-ask-herdr extension.
 */

export type AskType = "text" | "confirm" | "select" | "multiselect";

export interface OptionObject {
	label: string;
	description?: string;
}

export interface AskParams {
	question: string;
	type?: AskType;
	options?: (string | OptionObject)[];
	default?: string;
	timeout?: number;
	allow_custom?: boolean;
}

export interface OptionItem {
	label: string;
	value: string;
	description?: string;
}

export interface AskDetails {
	question: string;
	type: AskType;
	options: (string | OptionObject)[] | undefined;
	answer: string | boolean | string[] | null;
	cancelled: boolean;
	custom?: boolean;
}

// Sentinel value used internally for the "Other (custom)" menu item.
export const CUSTOM_SENTINEL = "__askuser_custom__";
export const CUSTOM_LABEL = "✎ Other (custom)";
