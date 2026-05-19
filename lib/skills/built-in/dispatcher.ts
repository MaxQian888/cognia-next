/**
 * Built-in skill dispatcher (ADR-0026).
 *
 * Single entry point for assistant-driven (or callback-driven) built-in
 * skill invocations. Owns the trust-model pipeline:
 *
 *   1. Resolve skill from the shared registry.
 *   2. Validate args against the skill's Zod input schema.
 *   3. PII gate on serialised args — reuses `hasNoLeakingPii` from
 *      `lib/twin/ingest/redact.ts` so the same red-line that protects
 *      Twin + Goal also protects every built-in skill call.
 *   4. Channel allowlist check against
 *      `ConversationOverrideRow.allowedBuiltInSkillIds` (supports the
 *      `"all"` sentinel, `[]` block-all, exact match, and `family.*`
 *      wildcards).
 *   5. `imAccess` check against session type (IM-bound vs in-app).
 *   6. Mutation-tier routing:
 *        - `"read"`        → audit + execute
 *        - `"write"`       → if `requireHitlForWrites !== false`, write
 *                            a skill_invoke binding + return pending; else
 *                            audit + execute.
 *        - `"destructive"` → always write binding + return pending.
 *
 * Every gate path writes a `connectorAudit` row so operators can see
 * exactly why a skill fired (or didn't). PII redaction runs on the args
 * BEFORE they're written to audit so the audit log never holds the
 * leaked content.
 *
 * Callbacks re-enter via `runBuiltInSkill({ hitlBypass: true })` after
 * `ConnectorBus.dispatchConnectorCallback` resolves the binding and
 * confirms the user clicked "Confirm".
 */

import { z } from "zod"

import { hasNoLeakingPii } from "@/lib/twin/ingest/redact"
import { append as appendAudit } from "@/lib/db/connector-audit"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { getSharedBuiltInSkillRegistry } from "./registry"
import type { BuiltInSkill, BuiltInSkillContext, BuiltInSkillResult } from "./types"

/** Default TTL for skill_invoke bindings — 7 days. Matches the existing pattern. */
const SKILL_INVOKE_TTL_MS = 7 * 24 * 3600 * 1000

/**
 * Run a built-in skill end-to-end.
 *
 * `args` is the raw structured payload the assistant passed via MCP
 * tool-use; the dispatcher re-validates it against the skill schema
 * even though the SDK already parsed it, because the dispatcher is also
 * called from the callback path (where args come out of Dexie and have
 * crossed a process boundary).
 *
 * Returns one of four terminal shapes; never throws. Errors during
 * execute are caught and surfaced as `{ status: "error", message }` so
 * the assistant tool-call result is always well-formed.
 */
export async function runBuiltInSkill(
  skillId: string,
  args: unknown,
  ctx: BuiltInSkillContext
): Promise<BuiltInSkillResult> {
  const now = ctx.now ?? Date.now()
  const skill = getSharedBuiltInSkillRegistry().get(skillId)
  if (!skill) {
    await safeAppendAudit({
      adapterId: ctx.imBinding?.adapterId ?? "<no-adapter>",
      kind: "builtin_skill_denied",
      at: now,
      conversationKey: ctx.imBinding?.conversationKey,
      reason: "unknown_skill",
      message: `Unknown skill id: ${skillId}`,
      fields: { skillId },
    })
    return {
      status: "denied",
      reason: "unknown_skill",
      message: `No built-in skill registered with id "${skillId}".`,
    }
  }

  // 2 — Validate args
  const parsed = skill.inputSchema.safeParse(args)
  if (!parsed.success) {
    const message = formatZodError(parsed.error)
    await safeAppendAudit({
      adapterId: ctx.imBinding?.adapterId ?? "<no-adapter>",
      kind: "builtin_skill_denied",
      at: now,
      conversationKey: ctx.imBinding?.conversationKey,
      reason: "invalid_args",
      message,
      fields: { skillId },
    })
    return { status: "denied", reason: "invalid_args", message }
  }
  const validArgs = parsed.data as unknown

  // 3 — PII gate on serialised args. Skill authors are encouraged to keep
  // arg shapes tight; this catches anything that leaks through despite that.
  const serialised = safeStringify(validArgs)
  if (!hasNoLeakingPii(serialised)) {
    // NOTE: do NOT include the raw args in the audit row — they contain PII
    // by definition. Only the redacted preview is safe.
    await safeAppendAudit({
      adapterId: ctx.imBinding?.adapterId ?? "<no-adapter>",
      kind: "builtin_skill_denied",
      at: now,
      conversationKey: ctx.imBinding?.conversationKey,
      reason: "pii_blocked",
      message: `PII detected in skill args for "${skillId}".`,
      fields: { skillId },
    })
    return {
      status: "denied",
      reason: "pii_blocked",
      message: "Built-in skill refused: arguments contain personally identifiable information.",
    }
  }

  // 4 + 5 — Channel allowlist & IM access gates. Both are no-ops for in-app
  // (non-IM) sessions: built-in skills are always exposed in desktop chat.
  if (ctx.imBinding) {
    const allowedListGate = checkAllowedList(skill, ctx.imOverrideRow?.allowedBuiltInSkillIds)
    if (!allowedListGate.allowed) {
      await safeAppendAudit({
        adapterId: ctx.imBinding.adapterId,
        kind: "builtin_skill_denied",
        at: now,
        conversationKey: ctx.imBinding.conversationKey,
        reason: allowedListGate.reason,
        message: allowedListGate.message,
        fields: { skillId },
      })
      return {
        status: "denied",
        reason: allowedListGate.reason,
        message: allowedListGate.message,
      }
    }

    const imAccessGate = checkImAccess(skill, ctx.imOverrideRow?.allowedBuiltInSkillIds)
    if (!imAccessGate.allowed) {
      await safeAppendAudit({
        adapterId: ctx.imBinding.adapterId,
        kind: "builtin_skill_denied",
        at: now,
        conversationKey: ctx.imBinding.conversationKey,
        reason: imAccessGate.reason,
        message: imAccessGate.message,
        fields: { skillId },
      })
      return {
        status: "denied",
        reason: imAccessGate.reason,
        message: imAccessGate.message,
      }
    }
  }

  // 6 — Mutation-tier routing.
  const hitlRequired = computeHitlRequired(
    skill,
    ctx.imBinding != null,
    ctx.imOverrideRow?.requireHitlForWrites,
    ctx.hitlBypass === true
  )

  if (hitlRequired) {
    // We MUST have a hitlSurface — `registry.register()` enforces this for
    // write/destructive skills, but guard anyway in case a future runtime
    // path strips the surface.
    if (!skill.hitlSurface) {
      return {
        status: "error",
        message: `Skill "${skill.id}" requires HITL but defines no hitlSurface.`,
      }
    }
    const surface = skill.hitlSurface(validArgs as never)
    if (!ctx.imBinding) {
      // Can't render confirm cards outside an IM channel. Should never
      // happen — desktop in-app uses a different consent overlay path.
      return {
        status: "error",
        message: `Skill "${skill.id}" requires HITL but session has no IM binding.`,
      }
    }
    // Persist the binding so the inbound callback can re-fire the skill
    // with `hitlBypass: true`.
    const actionId = `skill_invoke:${skill.id}:${cryptoRandomId()}`
    await recordCallbackBinding({
      adapterId: ctx.imBinding.adapterId,
      actionId,
      kind: "skill_invoke",
      surfaceId: surface.rootId,
      conversationKey: ctx.imBinding.conversationKey,
      createdAt: now,
      expiresAt: now + SKILL_INVOKE_TTL_MS,
      payload: { skillId: skill.id, args: validArgs as never },
    })
    await safeAppendAudit({
      adapterId: ctx.imBinding.adapterId,
      kind: "builtin_skill_hitl_pending",
      at: now,
      conversationKey: ctx.imBinding.conversationKey,
      reason: "hitl_required",
      message: `Awaiting user confirmation for ${skill.id}`,
      fields: { skillId: skill.id, mutation: skill.mutation, bindingActionId: actionId },
    })
    return {
      status: "pending_hitl",
      bindingId: `${ctx.imBinding.adapterId}:${actionId}`,
      surfaceId: surface.rootId,
    }
  }

  // Audit pending → execute → audit done.
  await safeAppendAudit({
    adapterId: ctx.imBinding?.adapterId ?? "<no-adapter>",
    kind: ctx.hitlBypass ? "builtin_skill_hitl_approved" : "builtin_skill_invoked",
    at: now,
    conversationKey: ctx.imBinding?.conversationKey,
    message: `Invoking ${skill.id}`,
    fields: { skillId: skill.id, mutation: skill.mutation, hitlBypass: ctx.hitlBypass === true },
  })

  try {
    const data = await skill.execute(validArgs as never, ctx)
    return { status: "ok", data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await safeAppendAudit({
      adapterId: ctx.imBinding?.adapterId ?? "<no-adapter>",
      kind: "builtin_skill_failed",
      at: now,
      conversationKey: ctx.imBinding?.conversationKey,
      reason: "execute_error",
      message,
      fields: { skillId: skill.id },
    })
    return { status: "error", message }
  }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

interface GateResult {
  allowed: boolean
  reason: string
  message: string
}

/**
 * Channel allowlist semantics:
 *   - `undefined` / `"all"` — skill defaults apply (per imAccess).
 *   - `[]` — block every built-in skill on this channel.
 *   - `string[]` — exact id match OR `family.*` wildcard. Both forms
 *     accepted so operators can opt in to a whole family without
 *     listing every subcommand.
 */
function checkAllowedList(skill: BuiltInSkill, allowed: string[] | "all" | undefined): GateResult {
  if (allowed === undefined || allowed === "all") {
    return { allowed: true, reason: "", message: "" }
  }
  if (Array.isArray(allowed) && allowed.length === 0) {
    return {
      allowed: false,
      reason: "channel_blocks_all_builtin_skills",
      message:
        "This channel has `allowedBuiltInSkillIds = []` — built-in skills are disabled here.",
    }
  }
  for (const entry of allowed) {
    if (entry === skill.id) return { allowed: true, reason: "", message: "" }
    if (entry.endsWith(".*")) {
      const prefix = entry.slice(0, -2)
      if (skill.family === prefix || skill.id.startsWith(prefix + ".")) {
        return { allowed: true, reason: "", message: "" }
      }
    }
  }
  return {
    allowed: false,
    reason: "not_allowed_for_channel",
    message: `Skill "${skill.id}" is not in this channel's allowedBuiltInSkillIds.`,
  }
}

/**
 * `imAccess` gate. Read skills with `imAccess: "always"` pass freely.
 * `"opt-in"` and `"blocked"` require explicit allowlist entry.
 */
function checkImAccess(skill: BuiltInSkill, allowed: string[] | "all" | undefined): GateResult {
  switch (skill.imAccess) {
    case "always":
      return { allowed: true, reason: "", message: "" }
    case "blocked":
      return {
        allowed: false,
        reason: "skill_blocked_in_im",
        message: `Skill "${skill.id}" is not available in IM channels.`,
      }
    case "readonly":
      // Available when channel has ANY allowlist configured (i.e. operator
      // is actively curating the surface). Default-undefined channels skip.
      if (allowed === undefined || allowed === "all") {
        return {
          allowed: false,
          reason: "readonly_requires_channel_curation",
          message: `Skill "${skill.id}" requires an explicit allowedBuiltInSkillIds on this channel.`,
        }
      }
      return { allowed: true, reason: "", message: "" }
    case "opt-in":
      // Channel must explicitly list the skill (or its family.*).
      if (!Array.isArray(allowed)) {
        return {
          allowed: false,
          reason: "destructive_opt_in_required",
          message: `Skill "${skill.id}" requires an explicit opt-in via allowedBuiltInSkillIds.`,
        }
      }
      return { allowed: true, reason: "", message: "" }
  }
}

/**
 * Mutation-tier HITL gate.
 *
 *   - `read`        → never HITL.
 *   - `write`       → HITL unless channel sets `requireHitlForWrites = false`.
 *   - `destructive` → HITL always (channel toggle ignored).
 *
 * Bypassed entirely when `hitlBypass === true` (callback re-fire path).
 */
function computeHitlRequired(
  skill: BuiltInSkill,
  isImSession: boolean,
  requireHitlForWrites: boolean | undefined,
  bypass: boolean
): boolean {
  if (bypass) return false
  if (!isImSession) {
    // In-app desktop chat doesn't go through A2UI confirm cards. The
    // consent overlay (Computer Use's ConsentOverlay equivalent) is the
    // future hook here — for v1 we let desktop chat run skills without
    // HITL because the user is staring at the chat already.
    return false
  }
  if (skill.mutation === "read") return false
  if (skill.mutation === "destructive") return true
  // write
  return requireHitlForWrites !== false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    // Circular ref or other shape problem. Fall back to a coarse serialise
    // so the PII gate still sees something to scan.
    return String(value)
  }
}

function cryptoRandomId(): string {
  // Avoid `crypto.randomUUID()` here so test environments without webcrypto
  // (older fake-indexeddb) still work — `Math.random` is fine for an
  // action-id namespace where the only requirement is uniqueness within
  // a TTL window.
  return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
}

async function safeAppendAudit(entry: Parameters<typeof appendAudit>[0]): Promise<void> {
  try {
    await appendAudit(entry)
  } catch {
    // Audit is best-effort — Dexie unavailability shouldn't break the skill.
  }
}
