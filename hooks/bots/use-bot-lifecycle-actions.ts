"use client"

/**
 * React binding for the installation lifecycle: install, configure, bind,
 * enable, uninstall.
 *
 * Split from `useBotControlActions` because the two answer different
 * availability questions. The three controls there can travel to a paired
 * Host, and none of these can, so `useBotLifecycleReadiness` reads
 * `resolveBotLifecycleWriteAvailability` rather than a per-command route.
 *
 * The readiness is a subscription, not a mount-time read, for the same reason
 * the controls' is: a desktop pairs with a remote Host after this page is
 * already open, and a control that asked once would keep offering a write
 * that now lands nowhere.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  BotControlTargetMissingError,
  BotDefinitionMissingError,
  BotLifecycleUnavailableError,
  BotNotInstallableError,
  bindBotCredential,
  installBotFromCatalog,
  resolveBotLifecycleWriteAvailability,
  setBotInstallationEnabled,
  uninstallBotInstallation,
  updateBotConfig,
  type InstallBotFromCatalogInput,
} from "@/lib/bot/control-writes"
import {
  bindingForCandidate,
  type BotCredentialCandidate,
} from "@/lib/bot/console/credential-candidates"
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

export interface BotLifecycleReadiness {
  availability: OperationAvailability
  can: boolean
}

const SERVER_READINESS: BotLifecycleReadiness = {
  availability: { state: "unsupported", reason: "requires-companion" },
  can: false,
}

export function useBotLifecycleReadiness(): BotLifecycleReadiness {
  const getSnapshot = useCallback((): string => {
    const availability = resolveBotLifecycleWriteAvailability()
    // Serialised so `useSyncExternalStore` compares by value. A fresh object
    // per call would re-render on every store tick forever.
    return JSON.stringify({ availability, can: availability.state === "available" })
  }, [])
  const getServerSnapshot = useCallback(() => JSON.stringify(SERVER_READINESS), [])
  const serialised = useSyncExternalStore(subscribeRouteInputs, getSnapshot, getServerSnapshot)
  return JSON.parse(serialised) as BotLifecycleReadiness
}

export interface BotLifecycleActions {
  /** Keys of the writes in flight, so one row can show its own spinner. */
  pending: ReadonlySet<string>
  /** Resolves to the new installation id, or undefined when it failed. */
  install: (input: InstallBotFromCatalogInput) => Promise<string | undefined>
  saveConfig: (installationId: string, config: Record<string, unknown>) => Promise<boolean>
  bindCredential: (
    installationId: string,
    slotId: string,
    candidate: BotCredentialCandidate | null
  ) => Promise<void>
  setEnabled: (installationId: string, enabled: boolean) => Promise<void>
  uninstall: (installationId: string) => Promise<boolean>
}

export function useBotLifecycleActions(): BotLifecycleActions {
  const t = useTranslations("bots")
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const withPending = useCallback(async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    setPending((current) => new Set(current).add(key))
    try {
      return await run()
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [])

  /**
   * One failure message for every lifecycle write.
   *
   * The four cases a user can act on are told apart. Everything else keeps the
   * underlying message rather than collapsing to "something went wrong", which
   * is the sentence that makes a bug report impossible to act on.
   */
  const report = useCallback(
    (error: unknown) => {
      if (error instanceof BotLifecycleUnavailableError) {
        toast.error(t("lifecycle.unavailable"), {
          description: t(`write.reason.${error.availability.reason}`),
        })
        return
      }
      if (error instanceof BotNotInstallableError) {
        toast.error(t("lifecycle.notInstallable"))
        return
      }
      if (error instanceof BotDefinitionMissingError) {
        toast.error(t("lifecycle.definitionMissing"))
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

  const install = useCallback(
    async (input: InstallBotFromCatalogInput) =>
      withPending(`install:${input.entry.definitionId}`, async () => {
        try {
          const row = await installBotFromCatalog(input)
          toast.success(t("lifecycle.installed", { name: input.entry.name }))
          return row.id
        } catch (error) {
          report(error)
          return undefined
        }
      }),
    [report, t, withPending]
  )

  const saveConfig = useCallback(
    async (installationId: string, config: Record<string, unknown>) =>
      withPending(`config:${installationId}`, async () => {
        try {
          await updateBotConfig(installationId, config)
          toast.success(t("lifecycle.configSaved"))
          return true
        } catch (error) {
          report(error)
          return false
        }
      }),
    [report, t, withPending]
  )

  const bindCredential = useCallback(
    async (installationId: string, slotId: string, candidate: BotCredentialCandidate | null) => {
      await withPending(`credential:${slotId}`, async () => {
        try {
          await bindBotCredential(
            installationId,
            slotId,
            candidate ? bindingForCandidate(candidate) : null
          )
          toast.success(candidate ? t("lifecycle.bound") : t("lifecycle.unbound"))
        } catch (error) {
          report(error)
        }
      })
    },
    [report, t, withPending]
  )

  const setEnabled = useCallback(
    async (installationId: string, enabled: boolean) => {
      await withPending(`enabled:${installationId}`, async () => {
        try {
          const row = await setBotInstallationEnabled(installationId, enabled)
          // The result, not the request. Asking to enable a Bot with an
          // unbound slot answers `needs_setup`, and reporting "enabled" there
          // would be the console telling the user something the row denies.
          toast.success(t(`lifecycle.status.${row.status}`))
        } catch (error) {
          report(error)
        }
      })
    },
    [report, t, withPending]
  )

  const uninstall = useCallback(
    async (installationId: string) =>
      withPending(`uninstall:${installationId}`, async () => {
        try {
          await uninstallBotInstallation(installationId)
          toast.success(t("lifecycle.uninstalled"))
          return true
        } catch (error) {
          report(error)
          return false
        }
      }),
    [report, t, withPending]
  )

  return useMemo(
    () => ({ pending, install, saveConfig, bindCredential, setEnabled, uninstall }),
    [pending, install, saveConfig, bindCredential, setEnabled, uninstall]
  )
}
