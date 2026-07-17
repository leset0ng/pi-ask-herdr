/**
 * Shared types for the pi-ask-herdr extension.
 */

export type AskType = "text" | "confirm" | "select" | "multiselect";

export interface OptionObject {
	label: string;
	description?: string;
}

/** A single question inside an ask_user batch. */
export interface AskQuestion {
	question: string;
	type?: AskType;
	options?: (string | OptionObject)[];
	default?: string;
	allow_custom?: boolean;
}

export interface AskParams {
	questions: AskQuestion[];
	/** Total timeout in milliseconds for the whole batch. */
	timeout?: number;
}

export interface OptionItem {
	label: string;
	value: string;
	description?: string;
}

/** Structured result for one answered question. */
export interface AskDetails {
	question: string;
	type: AskType;
	options: (string | OptionObject)[] | undefined;
	answer: string | boolean | string[] | null;
	cancelled: boolean;
	custom?: boolean;
}

/** Structured result for the whole ask_user call. */
export interface AskBatchDetails {
	answers: AskDetails[];
	cancelled: boolean;
}

// Sentinel value used internally for the "Other (custom)" menu item.
export const CUSTOM_SENTINEL = "__askuser_custom__";
export const CUSTOM_LABEL = "✎ Other (custom)";
