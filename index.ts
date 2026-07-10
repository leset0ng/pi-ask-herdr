/**
 * pi-ask-herdr
 *
 * A Pi extension that adds an `askuser` tool so the agent can ask the user
 * for input when it needs a decision to proceed.
 *
 * When Pi is running inside a Herdr pane, the extension also:
 *   - reports the pane agent state as `blocked` while waiting for an answer
 *   - sends a Herdr toast notification so the user knows input is needed
 *   - restores the agent state after the user answers
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createConnection } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AskType = "text" | "confirm" | "select";

interface AskParams {
	question: string;
	type?: AskType;
	options?: string[];
	default?: string;
	timeout?: number;
}

interface AskDetails {
	question: string;
	type: AskType;
	options: string[] | undefined;
	answer: string | boolean | null;
	cancelled: boolean;
}

interface HerdrReport {
	pane_id: string;
	source: string;
	agent: string;
	state: "blocked" | "working" | "idle";
	message?: string;
	custom_status?: string;
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

function herdrPaneId(): string | undefined {
	return process.env.HERDR_PANE_ID;
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

async function herdrReportAgent(state: "blocked" | "working" | "idle", message?: string) {
	const paneId = herdrPaneId();
	if (!paneId) return;

	const params: HerdrReport = {
		pane_id: paneId,
		source: "pi:askuser",
		agent: "pi",
		state,
		message,
	};
	if (state === "blocked") {
		params.custom_status = "askuser";
	}

	try {
		await herdrRequest<{ type: string }>("pane.report_agent", params);
	} catch (err) {
		// Non-fatal: Herdr state reporting is best-effort.
		console.error("[pi-ask-herdr] report_agent failed:", err);
	}
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

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function makeSignal(timeout?: number): AbortSignal | undefined {
	if (!timeout || timeout <= 0) return undefined;
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeout);
	return controller.signal;
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
	const signal = makeSignal(params.timeout);

	switch (type) {
		case "confirm": {
			const ok = await ctx.ui.confirm(question, undefined, signal ? { signal } : undefined);
			return {
				question,
				type,
				options: undefined,
				answer: ok === null ? null : ok,
				cancelled: ok === null,
			};
		}

		case "select": {
			const options = params.options ?? [];
			if (options.length === 0) {
				ctx.ui.notify("askuser: select requires options", "error");
				return { question, type, options, answer: null, cancelled: true };
			}
			const choice = await ctx.ui.select(question, options);
			return {
				question,
				type,
				options,
				answer: choice ?? null,
				cancelled: choice === null,
			};
		}

		case "text":
		default: {
			const text = await ctx.ui.input(question, params.default ?? "", signal ? { signal } : undefined);
			return {
				question,
				type,
				options: undefined,
				answer: text ?? null,
				cancelled: text === null,
			};
		}
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
	return `User answered: ${details.answer}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function askuserHerdr(pi: ExtensionAPI) {
	const AskParamsSchema = Type.Object({
		question: Type.String({ description: "The question to ask the user" }),
		type: Type.Optional(
			StringEnum(["text", "confirm", "select"] as const, {
				description: "Input type: text (default), confirm, or select",
			}),
		),
		options: Type.Optional(
			Type.Array(Type.String(), { description: "Required when type is select" }),
		),
		default: Type.Optional(Type.String({ description: "Default value for text input" })),
		timeout: Type.Optional(
			Type.Number({ description: "Optional timeout in milliseconds before auto-cancelling" }),
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
			"For askuser with type 'select', always provide the options array.",
			"Keep the question concise but include enough context for the user to answer.",
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

			// Validate select input up front.
			if (params.type === "select" && (!params.options || params.options.length === 0)) {
				return {
					content: [
						{ type: "text", text: "askuser error: type 'select' requires an options array." },
					],
					details: {
						question: params.question,
						type: "select",
						options: params.options,
						answer: null,
						cancelled: true,
					} satisfies AskDetails,
				};
			}

			// Tell Herdr (if available) that this pane is blocked waiting for input.
			if (isHerdrEnv()) {
				await herdrReportAgent("blocked", "Waiting for user answer");
				await herdrNotify("Pi needs input", params.question);
			}

			const details = await askInTui(params, ctx);

			// Restore agent state now that the prompt is done.
			if (isHerdrEnv()) {
				await herdrReportAgent(details.cancelled ? "idle" : "working");
			}

			return {
				content: [{ type: "text", text: renderAnswer(details) }],
				details,
			};
		},
	});

}
