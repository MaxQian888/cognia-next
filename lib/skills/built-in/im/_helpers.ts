/**
 * Shared helpers for the platform-neutral `im.*` skill family (W2 multi-bot).
 *
 * Unlike the `lark.*` families (which shell out to lark-cli), `im.*` skills
 * call the RUNNING ADAPTER INSTANCE through the optional chat-management
 * methods on `PlatformAdapter` — the platform-generic seam. Which platform
 * serves a call is decided purely by adapter resolution + capability flags,
 * never by platform-specific code up here.
 */

import type { Capability } from "@/types/connectors/capability"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"
import type { BuiltInSkillContext } from "../types"

export interface ResolvedChatAdapter {
  adapter: PlatformAdapter
  adapterId: string
  platform: PlatformKind
}

/**
 * Resolve which running adapter instance a chat-management skill should act
 * through:
 *   1. an explicit `adapterId` argument (multi-bot disambiguation),
 *   2. the session's IM binding (`ctx.imBinding.adapterId`),
 *   3. desktop fallback — the SINGLE running adapter whose declared
 *      capabilities cover every `requiredCaps` entry. Zero → actionable
 *      error; several → error listing candidates so the model re-calls with
 *      `adapterId`.
 * Then assert the adapter is running, healthy, and actually implements the
 * needed method(s) — a capability flag without the method is an adapter bug
 * we surface loudly instead of a cryptic `undefined is not a function`.
 */
export async function resolveChatCapableAdapter(
  ctx: BuiltInSkillContext,
  requiredCaps: readonly Capability[],
  explicitAdapterId?: string
): Promise<ResolvedChatAdapter> {
  const { getRunningAdapter, listRunningAdapters } = await import("@/lib/connectors/lifecycle")

  const covers = (adapter: PlatformAdapter): boolean =>
    requiredCaps.every((cap) => adapter.meta.capabilities.includes(cap))

  let adapterId = explicitAdapterId?.trim() || ctx.imBinding?.adapterId
  if (!adapterId) {
    const candidates = listRunningAdapters().filter((e) => covers(e.adapter))
    if (candidates.length === 0) {
      throw new Error(
        `No connected platform supports this operation (requires: ${requiredCaps.join(", ")}). Connect a capable adapter in Settings → Connections.`
      )
    }
    if (candidates.length > 1) {
      const ids = candidates.map((e) => `${e.adapter.id} (${e.adapter.meta.type})`).join(", ")
      throw new Error(
        `Multiple connected bots support this operation — pass adapterId to pick one of: ${ids}.`
      )
    }
    adapterId = candidates[0].adapter.id
  }

  const entry = getRunningAdapter(adapterId)
  if (!entry) {
    throw new Error(
      `Adapter ${adapterId} is not running — reconnect it from Settings → Connections → Health, or pass a different adapterId.`
    )
  }
  const adapter = entry.adapter
  if (adapter.health().state !== "running") {
    throw new Error(
      `Adapter ${adapterId} is not healthy (${adapter.health().state}) — reconnect it from Settings → Connections → Health.`
    )
  }
  if (!covers(adapter)) {
    throw new Error(
      `Adapter ${adapterId} (${adapter.meta.type}) does not declare the required capabilities: ${requiredCaps.join(", ")}.`
    )
  }
  return { adapter, adapterId, platform: adapter.meta.type }
}

/**
 * Assert an optional chat-management method actually exists on the adapter.
 * Capability flag present + method absent = adapter implementation bug.
 */
export function requireMethod<K extends keyof PlatformAdapter>(
  resolved: ResolvedChatAdapter,
  method: K
): NonNullable<PlatformAdapter[K]> {
  const fn = resolved.adapter[method]
  if (typeof fn !== "function") {
    throw new Error(
      `Adapter ${resolved.adapterId} declares the capability but does not implement ${String(method)}() — adapter bug.`
    )
  }
  return fn as NonNullable<PlatformAdapter[K]>
}

/**
 * Uniform error funnel for chat-management calls: scope errors are persisted
 * onto the adapter row (whoami panel renders them) and rethrown with their
 * already-actionable message; everything else passes through untouched.
 */
export async function withScopeCapture<T>(adapterId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ChatManagementScopeError) {
      await persistMissingScope(adapterId, err.requiredScope)
    }
    throw err
  }
}

async function persistMissingScope(adapterId: string, scope: string): Promise<void> {
  try {
    const { getAdapterInstance, updateAdapterInstance } = await import("@/lib/db/adapter-instances")
    const row = await getAdapterInstance(adapterId)
    const scopes = new Set(row?.lastMissingScopes ?? [])
    if (scopes.has(scope)) return
    scopes.add(scope)
    await updateAdapterInstance(adapterId, { lastMissingScopes: [...scopes].sort() })
  } catch {
    // Best-effort — the thrown ChatManagementScopeError already carries the
    // actionable message; a failed persist must not mask it.
  }
}

/** Truncate a message preview for HITL cards. */
export function previewText(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}
