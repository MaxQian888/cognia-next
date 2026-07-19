/**
 * Plugin SDK — `extensions` subpath.
 *
 * Re-exports the canonical extension-point identifiers a plugin targets
 * when mounting React components into host UI slots, plus the contract
 * shape governance/diagnostics tools use to audit slot coverage.
 *
 * Sources:
 *  - `lib/plugin/contracts/plugin-points.ts` — canonical extension-point
 *    enumeration, contract shapes, and the read-only
 *    `getExtensionPointContract(id)` accessor.
 *  - `types/plugin/plugin.ts` — `ExtensionPoint` alias and the
 *    `ExtensionOptions` / `ExtensionRegistration` / `ExtensionProps`
 *    surfaces consumed by `PluginExtensionAPI.register(...)`.
 *
 * The runtime API (`PluginExtensionAPI`) lives on the single public
 * `PluginContext` and is re-exported from `@cognia/plugin-sdk/context`.
 * The host mounts slots via `<PluginExtensionSlot id="..." />` (internal
 * component) — plugins never instantiate that themselves.
 */

/** Stable extension slots that third-party plugins may target. */
export const CANONICAL_EXTENSION_POINTS = [
  "sidebar.left.top",
  "sidebar.left.bottom",
  "sidebar.right.top",
  "sidebar.right.bottom",
  "toolbar.left",
  "toolbar.center",
  "toolbar.right",
  "statusbar.left",
  "statusbar.center",
  "statusbar.right",
  "chat.header",
  "chat.footer",
  "chat.input.above",
  "chat.input.below",
  "chat.input.actions",
  "chat.input.menu",
  "chat.message.before",
  "chat.message.after",
  "chat.message.actions",
  "chat.message.footer",
  "chat.tool-call.actions",
  "chat.message-part.actions",
  "artifact.toolbar",
  "artifact.actions",
  "canvas.toolbar",
  "canvas.sidebar",
  "goal.toolbar",
  "goal.detail.actions",
  "pet.console.tab",
  "pet.panel.actions",
  "perf.panel",
  "terminal.toolbar",
  "agent.team.panel",
  "agent.team.report",
  "agent.teammate.actions",
  "agent.team.task.actions",
  "agent.team.board.toolbar",
  "agent.external-session.toolbar",
  "twin.panel.header",
  "twin.persona.panel",
  "twin.settings.cards",
  "twin.overview.panel",
  "panel.header",
  "panel.footer",
  "settings.general",
  "settings.appearance",
  "settings.ai",
  "settings.plugins",
  "command-palette",
  "inbox.sidebar.section",
  "inbox.conversation.actions",
  "inbox.composer.actions",
  "inbox.draft.actions",
  "vscode.sidebar.view",
  "vscode.webview.panel",
  "vscode.activity-bar",
  "vscode.terminal.output",
] as const

export type CanonicalExtensionPoint = (typeof CANONICAL_EXTENSION_POINTS)[number]

export type {
  ExtensionPoint,
  ExtensionOptions,
  ExtensionRegistration,
  ExtensionProps,
} from "@/types/plugin/plugin"
