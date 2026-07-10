/**
 * Herdr integration helpers.
 *
 * - Detects whether Pi is running inside a Herdr pane.
 * - Sends toast notifications via the Herdr Unix socket.
 * - Reports blocked/working state through the official Herdr Pi integration
 *   event bus (`herdr:blocked`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection } from "node:net";

export function isHerdrEnv(): boolean {
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

export async function herdrNotify(title: string, body: string) {
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

export function setHerdrBlocked(pi: ExtensionAPI, active: boolean, label?: string) {
	try {
		pi.events.emit("herdr:blocked", { active, label });
	} catch (err) {
		console.error("[pi-ask-herdr] failed to emit herdr:blocked:", err);
	}
}
