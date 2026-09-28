import type { HookOutcome, HookAudit, HookEnvelope } from "./kernel/types.ts"

// --- Timeline projection (mirror of sidecar.rs:build_hook_fire_payload) ------

/** Derive the timeline outcome by precedence: block > context > warning. */
export function hookFireOutcome(dec: HookOutcome & { warnings?: string[] }) {
  if (dec.block !== undefined) return "blocked"
  if (dec.additionalContext !== undefined) return "context"
  if (dec.warnings && dec.warnings.length > 0) return "warning"
  return null
}

/**
 * Build the synthetic `hook_fire` SDK-system envelope, or `null` for a no-op
 * fire. Shape matches the Rust `build_hook_fire_payload` inner event so the
 * renderer's `hook-notice-part` renders sidecar- and Rust-emitted fires alike.
 */
export function buildHookFirePayload(
  sessionId: string | undefined,
  eventName: string,
  toolName: string | null | undefined,
  dec: HookOutcome & { warnings?: string[] }
): HookEnvelope | null {
  const outcome = hookFireOutcome(dec)
  if (!outcome) return null
  return {
    type: "event",
    sessionId,
    event: {
      type: "system",
      subtype: "hook_fire",
      hook_event: eventName,
      tool_name: toolName ?? null,
      outcome,
      block: dec.block ?? null,
      additional_context: dec.additionalContext ?? null,
      warnings: dec.warnings ?? [],
    },
  }
}

export function buildHookAuditPayload(
  sessionId: string | undefined,
  audit: HookAudit
): HookEnvelope {
  return {
    type: "event",
    sessionId,
    event: {
      type: "system",
      subtype: "hook_audit",
      ...audit,
    },
  }
}
