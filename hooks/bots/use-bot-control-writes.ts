"use client"

/**
 * React binding for the Bot control write facade.
 *
 * Two jobs, and they are separate on purpose.
 *
 * `useBotWriteReadiness` answers "can this control act", per command, as a
 * subscription over every input the route depends on. A control that only
 * asked at mount would keep offering itself after the desktop it was reading
 * paired with a remote host.
 *
 * `useBotControlActions` performs the write and reports the outcome. It never
 * decides availability: a component that could disable a control and also
 * catch its refusal has two answers to the same question, and they drift.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  BOT_WRITE_COMMANDS,
  BotControlTargetMissingError,
  BotWriteUnavailableError,
  replayBotDeliveryWrite,
  resolveBotWriteAvailability,
  resolveBotWriteRoute,
  runBotManually,
  setBotTriggerArmed,
  type BotWriteCommand,
  type BotWriteRoute,
} from "@/lib/bot/control-writes"
import type { OperationAvailability } from "@/lib/runtime/operation-availability"
import { subscribeRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

function subscribeRouteInputs(onChange: () => void): () => void {
  const unsubscribeRemote = subscribeActiveRemoteTransport(onChange)
  const unsubscribeSnapshot = subscribeRuntimeSnapshot(onChange)
  const unsubscribeStore = useRemoteHostStore.subscribe(onChange)
  return () => {
    unsubscribeRemote()
    unsubscribeSnapshot()
    unsubscribeStore()
  }
}

export interface BotWriteReadiness {
  route: BotWriteRoute
  availability: OperationAvailability
  /** The one boolean a control needs. */
  can: boolean
}

const SERVER_READINESS: BotWriteReadiness = {
  route: "unavailable",
  availability: { state: "unsupported", reason: "requires-companion" },
  can: false,
}

export function useBotWriteReadiness(command: BotWriteCommand): BotWriteReadiness {
  const getSnapshot = useCallback((): string => {
    const route = resolveBotWriteRoute(command)
    const availability = resolveBotWriteAvailability(command)
    // Serialised so `useSyncExternalStore` compares by value. Returning a
    // fresh object each call would re-render on every store tick forever.
    return JSON.stringify({ route, availability, can: availability.state === "available" })
  }, [command])
  const getServerSnapshot = useCallback(() => JSON.stringify(SERVER_READINESS), [])
  const serialised = useSyncExternalStore(subscribeRouteInputs, getSnapshot, getServerSnapshot)
  return JSON.parse(serialised) as BotWriteReadiness
}

export interface BotControlActions {
  /** Ids of the writes currently in flight, so one row can show its own spinner. */
  pending: ReadonlySet<string>
  setTriggerArmed: (installationId: string, triggerId: string, armed: boolean) => Promise<void>
  runNow: (
    installationId: string,
    triggerId?: string,
    input?: Record<string, unknown>
  ) => Promise<void>
  replayDelivery: (deliveryId: string) => Promise<void>
}

export function useBotControlActions(): BotControlActions {
  const t = useTranslations("bots")
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const withPending = useCallback(async (key: string, run: () => Promise<void>) => {
    setPending((current) => new Set(current).add(key))
    try {
      await run()
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [])

  /**
   * One failure message for every write.
   *
   * The three cases a user can act on are told apart, and everything else
   * falls through to the message with the reason in it rather than a generic
   * "something went wrong", which is the sentence that makes a bug report
   * impossible to act on.
   */
  const report = useCallback(
    (error: unknown) => {
      if (error instanceof BotWriteUnavailableError) {
        toast.error(t("write.unavailable"), {
          description: t(`write.reason.${error.availability.reason}`),
        })
        return
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "bot_delivery_replay_unavailable"
      ) {
        toast.error(t("write.retryUnavailable"))
        return
      }
      if (error instanceof BotControlTargetMissingError) {
        toast.error(t(`write.missing.${error.what}`))
        return
      }
      toast.error(t("write.failed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    },
    [t]
  )

  const setTriggerArmedAction = useCallback(
    async (installationId: string, triggerId: string, armed: boolean) => {
      await withPending(`trigger:${triggerId}`, async () => {
        try {
          await setBotTriggerArmed({ installationId, triggerId, armed })
          toast.success(t(armed ? "write.armed" : "write.disarmed"))
        } catch (error) {
          report(error)
        }
      })
    },
    [report, t, withPending]
  )

  const runNow = useCallback(
    async (installationId: string, triggerId?: string, input?: Record<string, unknown>) => {
      await withPending(`run:${installationId}`, async () => {
        try {
          const result = await runBotManually({
            installationId,
            ...(triggerId ? { triggerId } : {}),
            ...(input ? { input } : {}),
            // Minted per press. Two presses are two runs, and only a fresh key
            // can tell that from a retry of one.
            idempotencyKey: crypto.randomUUID(),
          })
          toast.success(
            result === undefined
              ? t("write.submitted")
              : result.created
                ? t("write.started")
                : t("write.alreadyQueued")
          )
        } catch (error) {
          report(error)
        }
      })
    },
    [report, t, withPending]
  )

  const replayDelivery = useCallback(
    async (deliveryId: string) => {
      await withPending(`delivery:${deliveryId}`, async () => {
        try {
          const replayed = await replayBotDeliveryWrite(deliveryId)
          toast.success(
            replayed === undefined
              ? t("write.retrySubmitted")
              : replayed
                ? t("write.replayed")
                : t("write.alreadyReplayed")
          )
        } catch (error) {
          report(error)
        }
      })
    },
    [report, t, withPending]
  )

  return useMemo(
    () => ({ pending, setTriggerArmed: setTriggerArmedAction, runNow, replayDelivery }),
    [pending, replayDelivery, runNow, setTriggerArmedAction]
  )
}

export { BOT_WRITE_COMMANDS }
