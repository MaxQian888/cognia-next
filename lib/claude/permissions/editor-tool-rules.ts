/**
 * Baked-in consent tier for the Pro IDE editor tools (ADR-0088 Phase 3).
 *
 * The five write tools are not equally consequential, and treating them
 * uniformly is wrong in both directions: prompting for every one turns "show me
 * that file" into a click-through, while allowing every one lets the agent
 * silently commit the user's own half-finished edits to disk.
 *
 * So the tier is stated once, here:
 *
 * - `open` / `reveal` — move the user's viewport. Nothing is written, and the
 *   user is looking at the result. Allowed.
 * - `show_editor_diff` — the proposal lives in memory and is served to a diff
 *   view; disk is untouched. This is the *review* affordance, so gating it
 *   behind a prompt would put a confirmation in front of asking for
 *   confirmation. Allowed.
 * - `apply_editor_edit` — reflects a write that has ALREADY happened through the
 *   agent's file tools, which had their own gate. Refusing it does not prevent
 *   the change; it only leaves the editor showing an anonymous external reload
 *   instead of something the user can undo. Allowed.
 * - `save_editor_buffers` — the one that writes the USER's unsaved edits, which
 *   no other gate has ever seen and which the user may be deliberately holding
 *   back. Asks.
 *
 * Precedence: this is merged as the LOWEST layer of `opts.permissionRuleset`,
 * so an explicit user/character rule in Settings → Agent → Permissions
 * overrides any of it, in either direction.
 */
import {
  EDITOR_WRITE_TOOL_NAMES,
  SAVE_EDITOR_BUFFERS_TOOL_NAME,
} from "@/lib/claude/editor-builtin-tools"
import type { PermissionVerdict, Ruleset } from "./ruleset"

/**
 * Server segment plugin-contributed tools are namespaced under on the AI-SDK
 * path (`mcp__cognia-plugin-tools__<tool>`); mirrors `PLUGIN_TOOLS_SERVER_NAME`
 * in `sidecar/dispatch/ai-sdk-tools.mjs`.
 */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

/** Verdict for one write tool. */
function verdictFor(tool: string): PermissionVerdict {
  return tool === SAVE_EDITOR_BUFFERS_TOOL_NAME ? "ask" : "allow"
}

/**
 * The tier as a ruleset.
 *
 * Each tool is keyed **twice** — bare and `mcp__`-prefixed — because the two
 * provider paths disagree on which one reaches `canUseTool`: the Anthropic path
 * sees the bare name, the AI-SDK path the namespaced one, and
 * `resolveToolVerdict` matches the tool key exactly with no prefix stripping.
 * Keying one form would silently apply the tier on one provider only, which is
 * the kind of gap that shows up as "it asked on my machine but not yours".
 */
export function buildEditorToolRuleset(): Ruleset {
  const rules: Ruleset = {}
  for (const tool of EDITOR_WRITE_TOOL_NAMES) {
    const verdict = verdictFor(tool)
    rules[tool] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${tool}`] = verdict
  }
  return rules
}
