/**
 * Bus-level help / welcome card dispatch — cross-provider.
 *
 * Two entry points the `ConnectorBus` calls inline:
 *
 *   - `maybeHandleHelpCommand(event, row)` — invoked in
 *     `dispatchInboundFull` before the route handler. When the inbound
 *     message text matches the adapter's `helpTriggers` (default `/help`,
 *     `帮助`), it serves a help card via `enqueueOutbound` and returns
 *     `true` so the bus skips the AI turn + workflow fan-out.
 *
 *   - `maybeSendWelcome(event, row)` — invoked from `applySystemEvent`
 *     (bot `member_added`) and from `dispatchInboundFull` on a `create`
 *     event. Sends a welcome card at most once per conversation, deduped
 *     through the inbound ledger's `"welcome"` namespace, gated on
 *     `welcomeCardEnabled`.
 *
 * Both build the surface with the platform-agnostic
 * `build-help-surface.ts` and route through `enqueueOutbound`, so every
 * adapter renders it natively or degrades to the plain-text mirror. All
 * Dexie / enqueue dependencies are injectable for tests.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { recordAndCheckInbound } from "@/lib/connectors/dedup"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { resolveInboundActivationPolicy } from "@/lib/connectors/conversation-admission"
import { normalizeQuickCommandList } from "@/lib/connectors/quick-commands"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { imModePresetFor } from "@/lib/connectors/composition/im-mode-presets"
import { projectStoredMode } from "@/lib/connectors/composition/mode-projection"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { buildHelpSurface, type HelpSurfaceMode } from "./build-help-surface"

/** Default help triggers when the adapter row leaves `helpTriggers` unset. */
export const DEFAULT_HELP_TRIGGERS = ["/help", "帮助"]

export interface HelpDispatchDeps {
  enqueue?: typeof enqueueOutbound
  /** Returns true when this is the first welcome for the conversation. */
  recordWelcome?: (adapterId: string, conversationKey: string) => Promise<boolean>
  audit?: typeof appendAudit
  now?: () => number
  readOverride?: typeof readForResolution
}

function resolveTriggers(row: AdapterInstanceRow): string[] {
  const configured = (row.helpTriggers ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  return configured.length > 0 ? configured : DEFAULT_HELP_TRIGGERS.map((t) => t.toLowerCase())
}

/**
 * The behaviour to disclose, or `undefined` when the bot answers on its own.
 *
 * Only `draft` and `silent` are disclosed, because those are the two cases
 * where the admission hint above it would otherwise lie: the card said "@ me
 * and I will reply", and then a silenced bot did not reply. Resolved from the
 * conversation's own axes first so a channel the operator silenced says so,
 * rather than reporting the bot-wide default that channel overrode.
 */
async function resolveDisclosedBehaviour(
  row: AdapterInstanceRow,
  conversationKey: string,
  readOverride: typeof readForResolution
): Promise<"draft" | "silent" | undefined> {
  const override = await readOverride(conversationKey).catch(() => undefined)
  // Same layering rule `resolveImEffectiveConfig` applies: a conversation that
  // pinned `mode` MEANS that mode, so its own pin suppresses the bot's axis
  // defaults rather than mixing with them.
  const conversationPinsMode = override?.mode !== undefined
  const { autonomy, engagement } = projectStoredMode({
    mode: override?.mode ?? row.defaultMode ?? "auto",
    // The card is sent before any run is dispatched, so the target only
    // matters here for engagement's `background`, which is not disclosed.
    targetKind: "direct",
    autonomy: override?.autonomy ?? (conversationPinsMode ? undefined : row.defaultAutonomy),
    engagement: override?.engagement ?? (conversationPinsMode ? undefined : row.defaultEngagement),
  })
  const preset = imModePresetFor({ autonomy, engagement })
  return preset === "draft" || preset === "silent" ? preset : undefined
}

function buildSurfaceForRow(
  event: NormalizedInboundEvent,
  row: AdapterInstanceRow,
  mode: HelpSurfaceMode,
  behaviour: "draft" | "silent" | undefined
) {
  // Unique per render: callbacks dedup on the action id (Lark bakes the
  // action id as the triggerId), so a stable surfaceId would let a button
  // fire only once ever. A per-send nonce gives each emitted card fresh
  // action ids, so re-issuing the card (e.g. another `/help`) restores
  // clickability.
  const surfaceId = `${mode}:${event.conversationKey}:${newIdempotencyKey().slice(0, 8)}`
  const surface = buildHelpSurface({
    surfaceId,
    mode,
    displayName: row.displayName,
    quickCommands: normalizeQuickCommandList(
      (row.settings as { quickCommands?: unknown } | undefined)?.quickCommands
    ),
    // Resolved, not raw. The settings UI writes `inboundActivationPolicy`, so
    // reading `atResponseStrategy` here left the "how to get me to reply"
    // section absent on every bot configured through the current forms — and
    // stale on a legacy row whose policy has since been changed. Same resolver
    // the bus admits on and the header chip reports.
    atStrategy: resolveInboundActivationPolicy(row),
    behaviour,
    skillFamilies: row.lastKnownSkillCapabilities,
    welcomeText: row.welcomeText,
  })
  return { surfaceId, segment: buildA2UISegment(surfaceId, surface) }
}

/**
 * Serve a help card if the inbound message is a help-trigger. Returns
 * `true` when handled (bus must skip the AI turn), `false` otherwise.
 */
export async function maybeHandleHelpCommand(
  event: NormalizedInboundEvent,
  row: AdapterInstanceRow,
  deps: HelpDispatchDeps = {}
): Promise<boolean> {
  // Only fresh user messages can be a help trigger.
  if (event.kind && event.kind !== "create") return false
  const text = event.plainText.trim().toLowerCase()
  if (text.length === 0) return false
  if (!resolveTriggers(row).includes(text)) return false

  const enqueue = deps.enqueue ?? enqueueOutbound
  const audit = deps.audit ?? appendAudit
  const at = (deps.now ?? Date.now)()

  const behaviour = await resolveDisclosedBehaviour(
    row,
    event.conversationKey,
    deps.readOverride ?? readForResolution
  )
  const { segment } = buildSurfaceForRow(event, row, "help", behaviour)
  await enqueue({
    adapterId: event.adapterId,
    conversationKey: event.conversationKey,
    request: {
      conversationRef: event.conversationRef,
      segments: [segment],
      // Fresh key per /help so a repeat request always re-sends the card.
      metadata: { idempotencyKey: newIdempotencyKey() },
    },
    source: "ai-run",
  })
  await audit({
    adapterId: event.adapterId,
    kind: "inbound.help_served",
    at,
    conversationKey: event.conversationKey,
  })
  return true
}

/**
 * Push a welcome card at most once per conversation. No-op when
 * `welcomeCardEnabled` is explicitly false or the conversation was already
 * welcomed. Safe to call on both `member_added` system events and the
 * first `create` event.
 */
export async function maybeSendWelcome(
  event: NormalizedInboundEvent,
  row: AdapterInstanceRow,
  deps: HelpDispatchDeps = {}
): Promise<boolean> {
  if (row.welcomeCardEnabled === false) return false
  if (!event.conversationKey) return false

  const recordWelcome =
    deps.recordWelcome ??
    ((adapterId: string, conversationKey: string) =>
      recordAndCheckInbound(adapterId, conversationKey, "welcome"))

  const isFirst = await recordWelcome(event.adapterId, event.conversationKey)
  if (!isFirst) return false

  const enqueue = deps.enqueue ?? enqueueOutbound
  const audit = deps.audit ?? appendAudit
  const at = (deps.now ?? Date.now)()

  const behaviour = await resolveDisclosedBehaviour(
    row,
    event.conversationKey,
    deps.readOverride ?? readForResolution
  )
  const { segment } = buildSurfaceForRow(event, row, "welcome", behaviour)
  await enqueue({
    adapterId: event.adapterId,
    conversationKey: event.conversationKey,
    request: {
      conversationRef: event.conversationRef,
      segments: [segment],
      metadata: { idempotencyKey: `welcome:${event.conversationKey}` },
    },
    source: "ai-run",
  })
  await audit({
    adapterId: event.adapterId,
    kind: "inbound.welcome_sent",
    at,
    conversationKey: event.conversationKey,
  })
  return true
}
