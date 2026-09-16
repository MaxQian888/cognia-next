import type { BotDeliverySummary, PluginBotsAPI } from "@/types/bot/api"
import type { BotHandlerResultV1 } from "@/types/bot/run"
import { requireOwnedBotRun } from "@/lib/bot/runtime/owned-run"
import { dispatchBotEvent, dispatchManualBotRun } from "@/lib/bot/events/dispatch"
import {
  assertBotEventPayloadSize,
  botEventId,
  buildBotEventEnvelope,
} from "@/lib/bot/events/envelope"
import { provenanceForBotOutput } from "@/lib/bot/events/provenance"
import { projectBotInstallationSnapshot } from "@/lib/bot/installation-snapshot"
import { getDb } from "@/lib/db/schema"
import { dismissBotDelivery, isTerminalBotDelivery } from "@/lib/db/bot-event-deliveries"
import { writeBotTriggerState } from "@/lib/db/bot-installations"
import { setBotTriggerArmedLocally } from "@/lib/bot/control-writes/local"
import { cancelBotRun, getLiveBotRunSignal } from "@/lib/bot/runtime/run"
import { sha256Hex } from "@/lib/share/hash"
import {
  beginBotRunStep,
  completeBotRunStep,
  failBotRunStep,
  getBotRunStep,
} from "@/lib/db/bot-run-steps"
import {
  BotRunCancelledError,
  BotRunParkedError,
  assertPublicStepName,
  journalBotStep,
} from "@/lib/bot/runtime/step"
import { appendBotRunLog, appendBotRunProgress } from "@/lib/bot/runtime/journal"
import {
  createHostStepApi,
  recordPendingPark,
  requireLiveBotRunSignal,
} from "@/lib/bot/runtime/host-step"
import { canonicalIntegrationValue } from "./bot-integration-binding"

const BOT_LOG_LEVELS = new Set(["debug", "info", "warn", "error"])

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function createBotsAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginBotsAPI {
  async function own(runId: string) {
    if (!hasPermission("agent:control")) throw new Error("ctx.bots requires agent:control")
    return requireOwnedBotRun(pluginId, runId)
  }

  /**
   * `own` plus liveness: the run must be executing on THIS host. A settled or
   * companion-mirrored run cannot be stepped, cancelled through a step
   * boundary, or journaled against from here.
   */
  async function ownLive(runId: string) {
    const owned = await own(runId)
    const signal = requireLiveBotRunSignal(runId)
    return { ...owned, signal }
  }
  return {
    async getInstallation(runId) {
      const { installation, resolved } = await own(runId)
      return projectBotInstallationSnapshot(installation, resolved.definition)
    },
    async enqueue(runId, input) {
      const { resolved } = await own(runId)
      const trigger = resolved.definition.triggers.find((item) => item.id === input.triggerId)
      if (!trigger || trigger.kind !== "manual")
        throw new Error("Bot child work must name a declared manual trigger")
      if (!input.eventId.trim() || !input.type.trim())
        throw new Error("Bot child event requires an identity and type")
      assertBotEventPayloadSize(input.payload)
      const envelope = buildBotEventEnvelope({
        source: "bot",
        sourceRecordId: input.eventId,
        type: input.type,
        installationId: resolved.installation.id,
        triggerId: trigger.id,
        occurredAt: Date.now(),
        payload: input.payload,
        ...(input.resource ? { resource: input.resource } : {}),
        provenance: {
          selfProduced: true,
          depth: 1,
          producedByInstallationId: resolved.installation.id,
        },
      })
      if (input.correlation)
        envelope.correlation = `${resolved.installation.id}::${input.correlation}`
      const delivery = await dispatchManualBotRun({ resolved, triggerId: trigger.id, envelope })
      return { deliveryId: delivery.id }
    },
    async cancelResource(runId, input) {
      const { installation } = await own(runId)
      const rows = await getDb()
        .botEventDeliveries.where("installationId")
        .equals(installation.id)
        .toArray()
      const affected = rows.filter(
        (row) =>
          row.runId !== runId &&
          !isTerminalBotDelivery(row.status) &&
          row.envelope.resource?.id === input.resourceId &&
          (!input.exceptRevision ||
            (row.envelope.payload as { revision?: unknown } | null)?.revision !==
              input.exceptRevision) &&
          (!input.exceptEventId || row.eventId !== botEventId("bot", input.exceptEventId))
      )
      for (const row of affected) {
        if (row.runId) {
          await cancelBotRun(row.runId)
        }
        await dismissBotDelivery(row.id, "resource changed or closed")
      }
      return affected.length
    },
    async recordMonitor(runId, patch) {
      const { installation } = await own(runId)
      for (const value of [patch.lastSuccessAt, patch.retryAt]) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0))
          throw new Error("Invalid monitor timestamp")
      }
      const db = getDb()
      await db.transaction("rw", db.botInstallations, async () => {
        const current = await db.botInstallations.get(installation.id)
        if (!current) throw new Error("Bot installation was removed")
        await db.botInstallations.update(current.id, {
          monitor: {
            ...current.monitor,
            // JSON/Python callers omit undefined fields. A successful sync
            // clears a previous failure even across that serialized boundary.
            ...(patch.lastSuccessAt !== undefined
              ? { lastError: undefined, retryAt: undefined }
              : {}),
            ...patch,
          },
          updatedAt: Date.now(),
        })
      })
    },
    async stepBegin(runId, name) {
      const { signal } = await ownLive(runId)
      assertPublicStepName(name)
      if (signal.aborted) throw new BotRunCancelledError(runId)
      const begun = await beginBotRunStep(runId, name, Date.now())
      if (begun.memoized) return { memoized: true, value: begun.value }
      await journalBotStep(
        runId,
        "step.started",
        name,
        { attempt: begun.attempt, via: "host-call" },
        Date.now
      )
      return { memoized: false, attempt: begun.attempt }
    },
    async stepComplete(runId, name, value) {
      await ownLive(runId)
      assertPublicStepName(name)
      const row = await getBotRunStep(runId, name)
      if (!row) throw new Error("Bot step was not begun in this run")
      if (row.status === "completed") {
        // Re-entry writes the same value again: a no-op. A DIFFERENT value is
        // the memoization key drifting under the handler, which corrupts every
        // step ordered after it — refuse it the way approval drift is refused.
        if (canonicalIntegrationValue(row.output) === canonicalIntegrationValue(value)) return
        throw new Error("Bot step value changed")
      }
      await completeBotRunStep(runId, name, value, Date.now())
      await journalBotStep(runId, "step.completed", name, { via: "host-call" }, Date.now)
    },
    async stepFail(runId, name, error) {
      await ownLive(runId)
      assertPublicStepName(name)
      const row = await getBotRunStep(runId, name)
      if (!row) throw new Error("Bot step was not begun in this run")
      await failBotRunStep(runId, name, error, Date.now())
      await journalBotStep(runId, "step.failed", name, { error, via: "host-call" }, Date.now)
    },
    async waitForApproval(runId, name, request) {
      const { installation } = await own(runId)
      const step = createHostStepApi({
        runId,
        ...(installation.projectId ? { projectId: installation.projectId } : {}),
      })
      try {
        const value = await step.waitForApproval(name, request)
        return { status: "settled", value }
      } catch (error) {
        if (error instanceof BotRunParkedError) {
          recordPendingPark(error)
          return {
            status: "parked",
            stepName: error.stepName,
            resumeAt: error.resumeAt,
            ...(error.waitingFor ? { waitingFor: error.waitingFor } : {}),
          }
        }
        throw error
      }
    },
    async waitForEvent(runId, name, input) {
      const { installation } = await own(runId)
      const step = createHostStepApi({
        runId,
        ...(installation.projectId ? { projectId: installation.projectId } : {}),
      })
      try {
        const value = await step.waitForEvent(name, input)
        return { status: "settled", value }
      } catch (error) {
        if (error instanceof BotRunParkedError) {
          recordPendingPark(error)
          return {
            status: "parked",
            stepName: error.stepName,
            resumeAt: error.resumeAt,
            ...(error.waitingFor ? { waitingFor: error.waitingFor } : {}),
          }
        }
        throw error
      }
    },
    async log(runId, level, message, data) {
      await ownLive(runId)
      if (!BOT_LOG_LEVELS.has(level)) throw new Error("Invalid bot log level")
      appendBotRunLog(runId, level, message, data, Date.now)
    },
    async progress(runId, update) {
      await ownLive(runId)
      if (
        update.fraction !== undefined &&
        (!Number.isFinite(update.fraction) || update.fraction < 0 || update.fraction > 1)
      ) {
        throw new Error("Invalid bot progress fraction")
      }
      appendBotRunProgress(runId, update, Date.now)
    },
    async writeTriggerState(runId, input) {
      const { installation, resolved } = await own(runId)
      const trigger = resolved.definition.triggers.find((item) => item.id === input.triggerId)
      if (!trigger || (trigger.kind !== "poll" && trigger.kind !== "derivedState")) {
        throw new Error("Trigger does not carry host-stored state")
      }
      for (const key of Object.keys(input)) {
        if (key !== "triggerId" && key !== "cursor" && key !== "watermark") {
          // Edge memory, debounce and last-fired are host-owned semantics:
          // a handler writing them turns an edge trigger into a level one.
          throw new Error("Only cursor and watermark may be written")
        }
      }
      if (
        input.cursor !== undefined &&
        (typeof input.cursor !== "string" || input.cursor.length > 4096)
      ) {
        throw new Error("Invalid trigger cursor")
      }
      if (
        input.watermark !== undefined &&
        (!Number.isFinite(input.watermark) || input.watermark < 0)
      ) {
        throw new Error("Invalid trigger watermark")
      }
      await writeBotTriggerState(installation.id, input.triggerId, {
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.watermark !== undefined ? { watermark: input.watermark } : {}),
      })
    },
    async setTriggerArmed(runId, input) {
      const { installation } = await own(runId)
      if (typeof input.armed !== "boolean") throw new Error("Trigger armed must be a boolean")
      await setBotTriggerArmedLocally({
        installationId: installation.id,
        triggerId: input.triggerId,
        armed: input.armed,
      })
    },
    async listDeliveries(runId, query) {
      const { installation } = await own(runId)
      const limit = Math.min(Math.max(Math.trunc(query?.limit ?? 50), 1), 200)
      // An indexed read, not `listBotDeliveries`: that helper slices to its
      // `limit` BEFORE any caller-side filter could apply, which would drop
      // matching deliveries ranked behind non-matching ones.
      const rows = await getDb()
        .botEventDeliveries.where("installationId")
        .equals(installation.id)
        .toArray()
      return rows
        .filter((row) => {
          if (row.syncedFromHost) return false
          if (query?.resourceId && row.envelope.resource?.id !== query.resourceId) return false
          if (query?.triggerId && row.triggerId !== query.triggerId) return false
          if (query?.status && !query.status.includes(row.status)) return false
          return true
        })
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, limit)
        .map((row): BotDeliverySummary => ({
          id: row.id,
          eventId: row.eventId,
          triggerId: row.triggerId,
          type: row.type,
          status: row.status,
          ...(row.runId ? { runId: row.runId } : {}),
          ...(row.envelope.resource ? { resource: row.envelope.resource } : {}),
          ...(row.envelope.correlation ? { correlation: row.envelope.correlation } : {}),
          receivedAt: row.receivedAt,
          ...(row.nextAttemptAt !== undefined ? { nextAttemptAt: row.nextAttemptAt } : {}),
          attempts: row.attempts,
        }))
    },
    async getRunResult(runId, input) {
      const { installation } = await own(runId)
      const run = await getDb().executionRuns.get(input.runId)
      if (!run || run.kind !== "bot" || run.sourceId !== installation.id) return null
      const step = await getBotRunStep(input.runId, "__host:result")
      const result =
        step?.status === "completed" ? (step.output as BotHandlerResultV1 | undefined) : undefined
      return {
        status: run.status,
        ...(result?.summary !== undefined ? { summary: result.summary } : {}),
        ...(result?.output !== undefined ? { output: result.output } : {}),
      }
    },
    async emit(runId, input) {
      // `own` not `ownLive`: a handler may emit as its last act, and nothing
      // `dispatchBotEvent` touches needs the live signal.
      const { installation, resolved } = await own(runId)
      if (!new RegExp(`^${escapeRegExp(pluginId)}\\.[A-Za-z0-9_.-]+$`).test(input.type)) {
        // A free-form type could spoof a host type (`run.completed`) or
        // another plugin's; the namespace makes every emitted event
        // attributable.
        throw new Error("Bot event type must be namespaced by the plugin id")
      }
      assertBotEventPayloadSize(input.payload)
      const delivery = await getDb().botEventDeliveries.where("runId").equals(runId).first()
      if (!delivery) throw new Error("Bot run has no delivery to chain from")
      const now = Date.now()
      const envelope = buildBotEventEnvelope({
        source: "bot",
        // Deterministic: a re-entered handler emitting the same thing lands on
        // the same event id, and arrival-dedup collapses the repeat.
        sourceRecordId: await sha256Hex(
          JSON.stringify([runId, input.type, canonicalIntegrationValue(input.payload)])
        ),
        type: input.type,
        installationId: "",
        triggerId: "",
        occurredAt: now,
        receivedAt: now,
        payload: input.payload,
        actor: { kind: "bot", id: resolved.definition.id },
        ...(input.resource ? { resource: input.resource } : {}),
        provenance: provenanceForBotOutput({
          runId,
          installationId: installation.id,
          cause: delivery.envelope,
        }),
      })
      const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope
      const result = await dispatchBotEvent({
        envelope: routable,
        query: { source: "bot", type: input.type },
        now,
      })
      if (getLiveBotRunSignal(runId)) {
        appendBotRunProgress(
          runId,
          { emitted: input.type, matched: result.enqueued.length },
          Date.now
        )
      }
      return { matchedInstallations: result.enqueued.length }
    },
  }
}
