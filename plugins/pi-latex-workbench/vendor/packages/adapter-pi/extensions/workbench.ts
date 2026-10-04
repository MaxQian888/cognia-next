/**
 * Controlled LaTeX workbench extension (M2-C).
 *
 * Registers the eight latex_* tools, the /latex command, and the
 * controlled-session handlers. Session binding is host-owned via
 * environment variables:
 *   LATEXWB_STATE     workbench state dir (default ./.latexwb)
 *   LATEXWB_WORKSPACE workspace id     (default "local")
 *   LATEXWB_PROJECT   bound project id (REQUIRED for tool calls)
 *   LATEXWB_PRINCIPAL operator id      (default "pi-operator")
 *   LATEXWB_SESSION   session id       (default pi-<pid>)
 *   LATEXWB_POLICY    policy id        (default "default")
 *   LATEXWB_PROTECTION strict|authoring (default: host-policy protection.mode,
 *                     else strict; unknown values fall back to strict)
 *   LATEXWB_REPO_ROOT repo root override (default: derived from this file)
 *
 * Smoke-tested via:
 *   pi -p --no-session -ne -e packages/adapter-pi/extensions/workbench.ts "…"
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkbenchExtension } from "../src/index.ts";

export default function workbench(pi: ExtensionAPI): void {
  registerWorkbenchExtension(pi);
}
