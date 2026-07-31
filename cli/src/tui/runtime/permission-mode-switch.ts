/**
 * The ONE decision point for "switch the session's permission mode".
 *
 * Four surfaces can change the mode — the `/mode` overlay, `/mode <name>`,
 * Shift+Tab, and a click on the footer's mode segment — and each used to apply
 * the pick directly. That is fine for the safe core, but `bypassPermissions`
 * disarms every approval gate for the rest of the session (and, since the mode
 * is forwarded, for the hosted external agent too), so reaching it must never be
 * a single unlabelled keystroke.
 *
 * Routing all four through {@link planPermissionModeSwitch} keeps that guarantee
 * in one pure function: entering a danger-tier mode returns a `confirm` plan
 * whose overlay re-dispatches `/mode <id> --force` on acknowledgement, and every
 * other switch returns `apply` with the notice to show. The App does the
 * applying; nothing here touches state.
 */
import { permissionModeMeta, requiresAcknowledgement } from "../state/permission-mode-meta"
import type { Overlay, PermissionMode } from "../state/types"

/**
 * The Shift+Tab / footer-click / `/mode` switch notice: the mode plus its
 * one-line "what runs without asking" summary, so the user sees the consequence
 * of the switch, not just the mode name.
 */
export function permissionModeNotice(mode: PermissionMode): string {
  return `Permission mode: ${mode} — ${permissionModeMeta(mode).runsWithoutAsking}`
}

/** Title of the danger-tier acknowledgement prompt. */
export const BYPASS_CONFIRM_TITLE = "Enable bypassPermissions for this session?"

/**
 * The acknowledgement body.
 *
 * States the external half explicitly: the mode is not a local UI preference,
 * it is forwarded to whichever agent is hosting the session, so a user who
 * accepts here is also accepting it for Codex / Claude Code.
 */
export const BYPASS_CONFIRM_BODY = `**Every tool call runs immediately.** File writes, shell commands, network requests and MCP calls all execute without asking you first, for the rest of this session.

**This applies to the external agent too.** Cognia forwards the same mode to whichever agent is hosting the session (Codex, Claude Code, …) and relaxes that agent's own sandbox as far as its protocol allows, so it will not stop to ask either.

Only continue in a directory you trust. Switch back any time with \`/mode\`.`

/** The mode a REFUSED startup acknowledgement falls back to. */
export const BYPASS_DECLINE_MODE: PermissionMode = "default"

/**
 * Build the acknowledgement overlay for a danger-tier mode.
 *
 * `cancelToMode` exists for the startup gate: a session launched with
 * `--bypass` (or a config that persists it) is ALREADY in the mode when the
 * prompt appears, so declining has to actively de-escalate. A mid-session switch
 * has applied nothing yet, so its cancel is a plain close.
 */
export function bypassConfirmOverlay(
  mode: PermissionMode,
  opts?: { cancelToMode?: PermissionMode }
): Extract<Overlay, { kind: "confirm" }> {
  return {
    kind: "confirm",
    title: BYPASS_CONFIRM_TITLE,
    body: BYPASS_CONFIRM_BODY,
    format: "markdown",
    // Re-enters the same switch path with the acknowledgement already given.
    onConfirmCommand: `mode ${mode} --force`,
    ...(opts?.cancelToMode ? { onCancelCommand: `mode ${opts.cancelToMode}` } : {}),
  }
}

/**
 * The acknowledgement shown when the session STARTS in a danger-tier mode
 * (`--bypass`, or a `permissionMode` persisted in config). Declining drops the
 * session to {@link BYPASS_DECLINE_MODE} rather than leaving it silently armed.
 */
export function startupBypassConfirmOverlay(
  mode: PermissionMode
): Extract<Overlay, { kind: "confirm" }> {
  return bypassConfirmOverlay(mode, { cancelToMode: BYPASS_DECLINE_MODE })
}

/** What the App should do about a requested mode switch. */
export type PermissionModeSwitchPlan =
  /** Apply `mode` now and show `notice`. */
  | { kind: "apply"; mode: PermissionMode; notice: string }
  /** Ask first; `overlay` re-dispatches the switch once acknowledged. */
  | { kind: "confirm"; mode: PermissionMode; overlay: Overlay }

/**
 * Decide whether a mode switch applies straight away or needs acknowledgement.
 *
 * `acknowledged` is the session's "the user has already accepted the danger-tier
 * warning" flag, so the confirm is a once-per-session gate rather than a toll on
 * every Shift+Tab lap. `force` is what the confirm overlay itself dispatches —
 * it is the acknowledgement, so it must not be gated by one.
 */
export function planPermissionModeSwitch(params: {
  next: PermissionMode
  acknowledged: boolean
  force?: boolean
}): PermissionModeSwitchPlan {
  const { next, acknowledged, force } = params
  if (requiresAcknowledgement(next) && !acknowledged && !force) {
    return { kind: "confirm", mode: next, overlay: bypassConfirmOverlay(next) }
  }
  return { kind: "apply", mode: next, notice: permissionModeNotice(next) }
}
