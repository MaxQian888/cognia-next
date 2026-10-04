/**
 * M0 smoke extension: proves the pi extension loader resolves this file,
 * resolves a cross-file `.ts` import into src/, and registers a tool.
 * Verified via `pi -p --no-session -ne -e packages/adapter-pi/extensions/smoke.ts`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { smokeMessage } from "../src/smoke.ts";

export default function latexwbSmoke(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "latexwb_smoke",
    label: "LaTeX WB Smoke",
    description: "M0 smoke tool: returns a fixed string. Not a product tool.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: smokeMessage() }], details: {} };
    },
  });
}
