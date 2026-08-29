/**
 * Resolve Anthropic Computer Use native tools for a chat turn.
 *
 * Called from `lib/claude/build-options.ts:resolveSendOptions` after the
 * character + skills + provider have been resolved. The function:
 *
 *   1. Returns immediately when `character.enableComputerUse !== true`.
 *   2. Reads the dynamic tool registry
 *      (`lib/plugin/registries/native-anthropic-tool-registry`).
 *   3. Filters by `character.computerUseSettings.allowedToolIds` when set.
 *   4. Maps each entry to the wire shape on `SendOptions.anthropicTools`.
 *   5. Computes the `anthropic-beta` header via `computeAnthropicBetaHeaders`
 *      and folds it into `SendOptions.appendHeaders["anthropic-beta"]`.
 *
 * Pure helper — no React, no I/O beyond the in-memory registry. Same
 * convention as `lib/goal/context-injector:appendGoalContext`.
 */

import {
  computeAnthropicBetaHeaders,
  listNativeAnthropicToolEntries,
} from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { hasSessionGrant } from "@/lib/claude/computer-use-session-grants"
import {
  clearActiveComputerUseSettings,
  setActiveComputerUseSettings,
} from "@/lib/claude/computer-use-active-settings"
import type { Character, SendOptions } from "@cognia/agent-config-types"

/**
 * ADR-0020 W3 — plugin tool names that the chat-side `canUseTool` modal
 * can suppress when a session grant is present (or the operator chose
 * `chatConsentMode: "auto"`). Mirror of the constant in
 * `hooks/chat/use-claude-chat.ts` — kept in two places because both
 * sides have to agree on the name set and the file boundary makes
 * sharing awkward (a third lib file just for one constant would be
 * worse than the duplication, and the names rarely change).
 */
export const COMPUTER_USE_PLUGIN_TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "query_elements",
  "expand_element",
  "perform_action",
  "find_text",
  "click_text",
  "mcp__cognia-plugin-tools__list_apps",
  "mcp__cognia-plugin-tools__get_app_state",
  "mcp__cognia-plugin-tools__query_elements",
  "mcp__cognia-plugin-tools__expand_element",
  "mcp__cognia-plugin-tools__perform_action",
  "mcp__cognia-plugin-tools__find_text",
  "mcp__cognia-plugin-tools__click_text",
] as const

export interface ApplyComputerUseInput {
  character: Character | null | undefined
  opts: SendOptions
  /**
   * G6 — set to true when the current session is bound to an IM
   * connector (`session.platformBinding` exists). The default policy
   * for IM sessions is to short-circuit before attaching Computer Use
   * tools so an inbound Telegram / Slack / Discord / Lark message can't
   * trigger screenshot / mouse / keyboard actions on the operator's
   * machine. `allowImComputerUse: true` re-enables the tools per
   * conversation (driven by `ConversationOverrideRow.allowComputerUse`).
   */
  imSession?: boolean
  allowImComputerUse?: boolean
  /**
   * Set to true when the turn originates from the mobile shell and the user
   * has NOT switched on `AppSettings.mobileComputerUseEnabled` (Settings →
   * Computer Use on the phone). Same shape as the G6 IM gate: a host-level
   * veto that outranks a character with Computer Use globally enabled.
   *
   * The mobile master switch documented itself as "when off, mobile-initiated
   * turns refuse to enter a computer-use loop regardless of per-character
   * `enableComputerUse`" while nothing anywhere read the flag — this input and
   * the matching term in `computerUseAllowedForChat` are what make that true.
   */
  mobileHostBlocked?: boolean
  /**
   * ADR-0020 W3 — chat session id, used to look up per-session grants
   * when `Character.computerUseSettings.chatConsentMode === "session-grant"`.
   * Optional because non-chat callers (workflow nodes, MCP) never
   * accumulate session grants. When unset the grant lookup short-circuits
   * and no tools are suppressed.
   */
  sessionId?: string
  /**
   * ADR-0020 W3 — live Rust gate tier for the `computerUse` surface
   * (`"off"` / `"whitelist"` / `"perCall"`). Required for
   * `chatConsentMode: "auto"` to make a decision: when the Rust gate
   * is at `perCall`, the chat-side modal is suppressed so only the
   * floating overlay fires (the user-confirmed "Rust overlay wins"
   * design from Round 2). build-options.ts fetches it via
   * `desktop.settingsGet()` ahead of the call and forwards. Optional
   * because non-Tauri / non-chat callers can't observe the gate.
   */
  computerUseGateTier?: "off" | "whitelist" | "perCall"
}

export interface ApplyComputerUseResult {
  /**
   * SendOptions updated in-place style: caller assigns the returned object
   * back to its local `opts`. Keeps the build-options resolver linear.
   */
  opts: SendOptions
  /**
   * Number of Anthropic tools that ended up on `opts.anthropicTools`.
   * Useful for callers that want to short-circuit follow-on work (e.g.,
   * skip the canUseTool wiring when zero).
   */
  attachedCount: number
}

export function applyComputerUseTools(input: ApplyComputerUseInput): ApplyComputerUseResult {
  const { character } = input
  const opts = { ...input.opts }
  if (!character?.enableComputerUse) {
    // Drop any stale cached settings for this session — disabling
    // Computer Use mid-session must not leave a force-tier zombie
    // around for the plugin executor to pick up.
    if (input.sessionId) clearActiveComputerUseSettings(input.sessionId)
    return { opts, attachedCount: 0 }
  }
  // ADR-0020 W1 audit-fix — stash the active character's
  // computerUseSettings so the chat-path plugin executor in
  // `plugins/computer-use/src/index.ts` can stamp
  // `ctx.forceTier: "perCall"` on every Tauri dispatch when the
  // operator chose `requireConsent: true`. Without this the Rust
  // CallContext.force_tier field was wired but never received a value
  // from the chat path (the Claude Agent SDK ignores
  // `opts.anthropicTools` so the field on that surface is dead).
  if (input.sessionId && character.computerUseSettings) {
    setActiveComputerUseSettings(input.sessionId, character.computerUseSettings)
  }
  // Mobile master switch — same short-circuit as the IM blacklist below, and
  // checked first because it is a device-wide veto rather than a
  // per-conversation one.
  if (input.mobileHostBlocked === true) {
    if (input.sessionId) clearActiveComputerUseSettings(input.sessionId)
    return { opts, attachedCount: 0 }
  }
  // G6 IM blacklist — short-circuit before the registry walk so even a
  // character that has Computer Use globally enabled can't fire native
  // tools through an IM-driven turn unless the operator opted in on
  // this specific conversation.
  if (input.imSession === true && input.allowImComputerUse !== true) {
    return { opts, attachedCount: 0 }
  }

  const entries = listNativeAnthropicToolEntries()
  if (entries.length === 0) {
    return { opts, attachedCount: 0 }
  }

  const allowedIds = character.computerUseSettings?.allowedToolIds
  const allowedSet = allowedIds && allowedIds.length > 0 ? new Set(allowedIds) : null
  const filtered = allowedSet ? entries.filter((e) => allowedSet.has(e.id)) : entries

  if (filtered.length === 0) {
    return { opts, attachedCount: 0 }
  }

  // ADR-0020 W1 — pull the per-character consent knobs (laid down on
  // SendOptions so Wave 3 dedup logic can read them after the registry
  // walk). `requireConsent` forces every tool's `forceTier` to perCall
  // so the Rust gate upgrades the next dispatch to RequireConsent.
  const settings = character.computerUseSettings
  const forceTier: "perCall" | undefined = settings?.requireConsent === true ? "perCall" : undefined
  const consentMode = settings?.chatConsentMode ?? "always-ask"
  opts.computerUseConsentMode = consentMode

  // ADR-0020 W3 — chat-modal suppression.
  //
  // Two consent modes can suppress the redundant chat-side prompt:
  //
  //   - `session-grant`: suppress when the operator has already
  //     approved this specific tool earlier in the session. The chat
  //     store's `respondToApproval` writes grants on the first allow;
  //     subsequent turns inside the same session skip the modal.
  //   - `auto`: defer to the Rust gate. When the live `computerUse`
  //     surface tier is `perCall`, the floating overlay alone gates the
  //     call (Round-2 user-confirmed "Rust overlay wins"); we add every
  //     computer-use plugin tool to the suppress list so the chat modal
  //     stays out of the way. Other tiers (`off` / `whitelist`) leave
  //     the chat modal to do its normal job — the gate either denies
  //     (chat modal will report) or pre-approves silently (chat modal
  //     is the only prompt the operator can see).
  //
  // Both modes union into `opts.suppressApprovalForTools` so the
  // sidecar's `canUseTool` short-circuit treats them identically.
  const grantSuppressions =
    consentMode === "session-grant" && input.sessionId
      ? COMPUTER_USE_PLUGIN_TOOL_NAMES.filter((toolName) =>
          hasSessionGrant(input.sessionId!, toolName)
        )
      : []
  const autoSuppressions =
    consentMode === "auto" && input.computerUseGateTier === "perCall"
      ? [...COMPUTER_USE_PLUGIN_TOOL_NAMES]
      : []
  if (grantSuppressions.length > 0 || autoSuppressions.length > 0) {
    const existing = opts.suppressApprovalForTools ?? []
    const dedup = new Set([...existing, ...grantSuppressions, ...autoSuppressions])
    opts.suppressApprovalForTools = Array.from(dedup)
  }

  // Map registry entries → wire shape. The renderer-only `executeIpc.invoke`
  // string travels with each tool so the sidecar can route `tool_use`
  // messages back without re-reading the registry.
  opts.anthropicTools = filtered.map((row) => {
    const def = row.entry
    return {
      name: def.name,
      type: def.type,
      betaHeader: def.betaHeader,
      displayWidthPx: def.displayWidthPx,
      displayHeightPx: def.displayHeightPx,
      displayNumber: def.displayNumber,
      enableZoom: def.enableZoom,
      executeIpc: def.executeIpc,
      permissionPolicy: def.permissionPolicy,
      ...(forceTier ? { forceTier } : {}),
    }
  })

  // Compose the beta header from the *original* tool defs so the
  // computeAnthropicBetaHeaders helper sees the canonical
  // `PluginNativeAnthropicToolDef` shape.
  const beta = computeAnthropicBetaHeaders(filtered.map((row) => row.entry))
  if (beta.length > 0) {
    const existingHeader = opts.appendHeaders?.["anthropic-beta"]
    const next = existingHeader ? `${existingHeader},${beta.join(",")}` : beta.join(",")
    opts.appendHeaders = {
      ...(opts.appendHeaders ?? {}),
      "anthropic-beta": dedupCsv(next),
    }
  }

  return { opts, attachedCount: filtered.length }
}

/**
 * De-duplicate a comma-separated header value while preserving first-seen
 * order. Idempotent — callers can merge multiple times without poisoning
 * the header.
 */
function dedupCsv(value: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of value.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.join(",")
}
