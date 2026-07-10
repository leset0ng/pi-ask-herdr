/**
 * pi-ask-herdr
 *
 * A Pi extension that adds an `askuser` tool and integrates with Herdr.
 *
 * Source modules live under `./src/`; this file is only the auto-discovered
 * entry point that Pi loads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskuserTool } from "./src/tool.ts";

export default function askuserHerdr(pi: ExtensionAPI) {
	registerAskuserTool(pi);
}
