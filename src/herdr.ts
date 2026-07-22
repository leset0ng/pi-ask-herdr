/**
 * Herdr integration helpers.
 *
 * - Detects whether Pi is running inside a Herdr pane.
 * - Reports blocked/working state through the official Herdr Pi integration
 *   event bus (`herdr:blocked`). Herdr itself shows a notification for
 *   blocked panes, so no extra notification is sent from here.
 * - Reports ask_user progress as a pane metadata token (`ask`) that Herdr can
 *   render in sidebar agent rows via a `$ask` row slot.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection } from "node:net";

export function isHerdrEnv(): boolean {
	return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

export function setHerdrBlocked(pi: ExtensionAPI, active: boolean, label?: string) {
	try {
		pi.events.emit("herdr:blocked", { active, label });
	} catch (err) {
		console.error("[pi-ask-herdr] failed to emit herdr:blocked:", err);
	}
}

/**
 * Send a single JSON-RPC-style request to the Herdr Unix socket and return
 * the matching result. Herdr speaks newline-delimited JSON.
 */
function herdrRequest<T>(method: string, params: object): Promise<T | undefined> {
	const socketPath = process.env.HERDR_SOCKET_PATH;
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

const METADATA_SOURCE = "pi-ask-herdr";
const METADATA_QUESTION_TOKEN = "ask";
const METADATA_COUNT_TOKEN = "ask_count";

/**
 * Keep the question and remaining count as separate Herdr tokens so Herdr can
 * truncate the question responsively while preserving the short count token.
 */
export function askMetadataTokens(questionTexts: string[]): Record<string, string | null> {
	const questions = questionTexts.map((text) => text.replace(/[\r\n]+/g, " ").trim()).filter(Boolean);
	return {
		[METADATA_QUESTION_TOKEN]: questions.length > 0 ? `❓ ${questions[0]}` : null,
		[METADATA_COUNT_TOKEN]: questions.length > 1 ? `+${questions.length - 1}` : null,
	};
}

/** Report pending questions without allowing metadata failures to break prompting. */
export async function reportAskMetadata(questionTexts: string[]): Promise<void> {
	try {
		await herdrRequest("pane.report_metadata", {
			pane_id: process.env.HERDR_PANE_ID,
			source: METADATA_SOURCE,
			tokens: askMetadataTokens(questionTexts),
		});
	} catch (err) {
		console.error("[pi-ask-herdr] pane.report_metadata failed:", err);
	}
}

/** Clear the sidebar token once the prompt is done. */
export async function clearAskMetadata(): Promise<void> {
	try {
		await herdrRequest("pane.report_metadata", {
			pane_id: process.env.HERDR_PANE_ID,
			source: METADATA_SOURCE,
			tokens: {
				[METADATA_QUESTION_TOKEN]: null,
				[METADATA_COUNT_TOKEN]: null,
			},
		});
	} catch (err) {
		console.error("[pi-ask-herdr] failed to clear pane metadata:", err);
	}
}
