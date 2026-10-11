"use client"

/**
 * Everything the phone's glance surfaces render from (ADR-0225 §9): the
 * phone's layout, one merged snapshot, where each module's data came from,
 * and how a module's request or click is carried out on a phone.
 *
 * One instance per shell (`MobileGlanceProvider`), shared by the home screen
 * and the Glance drawer, so the phone never builds the same slice twice.
 * Nothing is built while neither is on screen, and only what is on screen is
 * built: the pinned modules for the home screen, every visible one while the
 * drawer is open.
 *
 * A standalone phone builds every slice from its own data. A paired phone
 * builds recents itself and takes the rest from the desktop through
 * `glancePhoneStore`, which holds a lease only while one of those modules is
 * on screen (or the layout editor needs the desktop's plugin catalogue) and
 * the app is in the foreground.
 *
 * Plugin modules (ADR-0225 §6) are the phone's own plugins when standalone,
 * run here; the desktop's when paired, read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"

import type { GlanceContextValue } from "@/components/glance/glance-context"
import { useDocumentHidden } from "@/hooks/pet/use-document-visible"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { pinEntryHome, withEditedMobileEntries, withMobilePreset } from "@/lib/glance/layout-edit"
import { runGlancePluginAction } from "@/lib/glance/plugin-actions"
import { normalizeGlanceMobileSettings } from "@/lib/glance/mobile-layout"
import { glanceMobileOwnerHref } from "@/lib/glance/owner-routes"
import { glanceModulesFor } from "@/lib/glance/registry"
import { GLANCE_REMOTE_COMMANDS } from "@/lib/glance/remote/commands"
import { glanceDemandOf } from "@/lib/glance/remote/demand"
import { glancePhoneStore, type GlancePhoneState } from "@/lib/glance/remote/phone-store"
import {
  mergePhoneSnapshot,
  neededEntries,
  phoneLocalConfig,
  phoneOriginOf,
  type GlanceModuleOrigin,
} from "@/lib/glance/remote/phone-view"
import type { GlanceRequestBody, GlancePetCommand } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlancePluginCatalogEntry,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"
import type { PetInteractionKind } from "@/lib/pet/access/limits"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import type { GlanceEntryId, GlanceMobileSettings } from "@/types/glance/layout"

import { useGlanceSources } from "./use-glance-sources"

/** What a pet care button does through the desktop's remote pet care (ADR-0219). */
const PET_CARE_KIND: Record<GlancePetCommand, PetInteractionKind> = {
  "pet.feed": "fed",
  "pet.play": "played",
  "pet.pet": "petted",
  "pet.sleep": "slept",
  "pet.clean": "cleaned",
}

/** The operation a desktop advertises when it cares for its pet remotely. */
const PET_REMOTE_OPERATION = "pet_act"

export interface UseMobileGlanceOptions {
  drawerOpen: boolean
  homeVisible: boolean
  /** The layout editor is on screen: a paired phone then needs the desktop's plugin catalogue. */
  editorOpen?: boolean
  /** Navigate on the phone. */
  navigate: (href: string) => void
  /** Resume one conversation (the shell's own session switch). */
  openSession: (sessionId: string) => void
  /** Open the shortcut editor: the quick module's owner on a phone. */
  editShortcuts: () => void
  /** A click routed somewhere; the drawer closes behind it. */
  onRouted?: () => void
}

export interface UseMobileGlanceResult {
  settings: GlanceMobileSettings
  glance: GlanceContextValue
  originOf: (id: GlanceEntryId) => GlanceModuleOrigin | null
  remote: GlancePhoneState
  /** Renders a paired desktop's data. */
  paired: boolean
  /** The desktop serves glance: true, false, or null until its manifest arrives. */
  supported: boolean | null
  /** The desktop's tray layout, when one was received, for "copy from desktop". */
  hostLayout: GlanceSnapshotV1["hostLayout"] | null
  /**
   * The plugin modules the editor can offer: the phone's own when standalone,
   * the desktop's (as last received) when paired.
   */
  pluginCatalog: readonly GlancePluginCatalogEntry[]
  /** Persist a new layout. Resolves to null or a `glance.errors.*` key. */
  save: (next: GlanceMobileSettings) => Promise<string | null>
}

export function useMobileGlance({
  drawerOpen,
  homeVisible,
  editorOpen = false,
  navigate,
  openSession,
  editShortcuts,
  onRouted,
}: UseMobileGlanceOptions): UseMobileGlanceResult {
  const stored = useSettingsStore((s) => s.settings?.mobileGlanceLayout)
  const legacyHome = useSettingsStore((s) => s.settings?.mobileHomeLayout)
  const legacyStats = useSettingsStore((s) => s.settings?.welcomeStats)
  const saveSettings = useSettingsStore((s) => s.save)
  const settings = useMemo(
    () =>
      normalizeGlanceMobileSettings(stored, {
        mobileHomeLayout: legacyHome,
        welcomeStats: legacyStats,
      }),
    [stored, legacyHome, legacyStats]
  )

  const hidden = useDocumentHidden()
  const onScreen = (drawerOpen || homeVisible) && !hidden
  const needed = useMemo(
    () => (onScreen ? neededEntries(settings.entries, drawerOpen) : []),
    [onScreen, settings.entries, drawerOpen]
  )

  // Paired, and whether the desktop serves glance.
  const runtime = useRuntimeSnapshot()
  const paired = runtime.target?.kind === "companion"
  const supported = !paired
    ? false
    : runtime.host
      ? runtime.host.compatible &&
        runtime.host.operations.includes(GLANCE_REMOTE_COMMANDS.subscribe)
      : null
  const petRemote =
    paired &&
    runtime.host?.compatible === true &&
    runtime.host.operations.includes(PET_REMOTE_OPERATION)

  // The phone's own build.
  const workspaceId = useProjectStore((s) => s.activeProjectId)
  const localConfig = useMemo(
    () => phoneLocalConfig(settings, needed, paired),
    [settings, needed, paired]
  )
  const local = useGlanceSources(onScreen, {
    config: localConfig,
    workspaceId,
    platform: "mobile",
  })

  // The desktop's build, while a host-sourced module is on screen.
  const wantsCatalog = paired && editorOpen && !hidden
  const demand = useMemo(
    () => glanceDemandOf(settings, needed, workspaceId, { catalog: wantsCatalog }),
    [settings, needed, workspaceId, wantsCatalog]
  )
  const wantsRemote = paired && supported === true && (demand.modules.length > 0 || demand.catalog)
  const demandKey = JSON.stringify(demand)
  // Hold the lease for as long as anything needs it, and change its demand in
  // place (opening the drawer adds modules): re-holding on every demand change
  // would end the lease and subscribe again each time.
  const demandKeyRef = useRef(demandKey)
  useEffect(() => {
    demandKeyRef.current = demandKey
  }, [demandKey])
  useEffect(() => {
    if (!wantsRemote) return
    return glancePhoneStore.hold(JSON.parse(demandKeyRef.current))
  }, [wantsRemote])
  useEffect(() => {
    if (wantsRemote) glancePhoneStore.setDemand(JSON.parse(demandKey))
  }, [wantsRemote, demandKey])
  const remote = useSyncExternalStore(
    glancePhoneStore.subscribe,
    glancePhoneStore.getState,
    glancePhoneStore.getState
  )

  const snapshot = useMemo<GlanceSnapshotV1>(
    () =>
      mergePhoneSnapshot(
        { version: GLANCE_SNAPSHOT_VERSION, epoch: 0, revision: 0, ...local.body },
        remote.snapshot,
        paired
      ),
    [local.body, remote.snapshot, paired]
  )

  const link = useMemo(() => ({ paired, supported, remote }), [paired, supported, remote])
  const originOf = useCallback((id: GlanceEntryId) => phoneOriginOf(id, link), [link])

  const save = useCallback(
    async (next: GlanceMobileSettings): Promise<string | null> => {
      try {
        await saveSettings({ mobileGlanceLayout: next })
        return null
      } catch {
        return "errors.requestFailed"
      }
    },
    [saveSettings]
  )

  const route = useCallback(
    (body: GlanceRequestBody) => {
      switch (body.kind) {
        case "open-fleet":
          navigate(glanceMobileOwnerHref("fleet") as string)
          break
        case "open-owner": {
          const href = glanceMobileOwnerHref(body.owner, body.itemId)
          if (href === null) editShortcuts()
          else navigate(href)
          break
        }
        case "open-session":
          openSession(body.sessionId)
          break
        default:
          return
      }
      onRouted?.()
    },
    [navigate, editShortcuts, openSession, onRouted]
  )

  const fromDesktop = paired && supported === true
  const send = useCallback(
    async (body: GlanceRequestBody): Promise<string | null> => {
      const patch = (apply: (current: GlanceMobileSettings) => GlanceMobileSettings) =>
        save(apply(settings))
      switch (body.kind) {
        case "open-fleet":
        case "open-owner":
        case "open-session":
          route(body)
          return null
        case "refresh":
          if (fromDesktop) return glancePhoneStore.request({ kind: "refresh" })
          await local.quota.refreshAll()
          return null
        case "quota-refresh":
          if (fromDesktop) return glancePhoneStore.request(body)
          return (await local.quota.refreshOne(body.key)) ? null : "errors.quotaRefresh"
        case "quota-enable":
          if (fromDesktop) return glancePhoneStore.request(body)
          return (await local.quota.enable(body.provider, body.accountId))
            ? null
            : "errors.quotaEnable"
        case "set-scope":
          return patch((c) => ({ ...c, scope: body.scope }))
        case "set-usage-scope":
          return patch((c) => ({
            ...c,
            options: { ...c.options, usage: { ...c.options.usage, scope: body.scope } },
          }))
        case "set-show-spend":
          return patch((c) => ({
            ...c,
            options: { ...c.options, usage: { ...c.options.usage, showSpend: body.showSpend } },
          }))
        case "set-activity-range":
          return patch((c) => ({
            ...c,
            options: { ...c.options, activity: { range: body.range } },
          }))
        case "set-layout": {
          // A desktop-shaped edit: keep each module's home pin.
          const pins = new Map(settings.entries.map((entry) => [entry.id, entry.home]))
          return patch((c) =>
            withEditedMobileEntries(
              c,
              body.entries.map((entry) => ({
                ...entry,
                home: !entry.hidden && pins.get(entry.id) === true,
              }))
            )
          )
        }
        case "apply-preset":
          return patch((c) => withMobilePreset(c, body.preset))
        case "pet-care": {
          if (!petRemote) return "errors.commandUnavailable"
          try {
            const [{ createPetRemoteClient }, { transport }] = await Promise.all([
              import("@/lib/pet/remote/client"),
              import("@/lib/tauri"),
            ])
            const result = await createPetRemoteClient(transport).act(PET_CARE_KIND[body.command])
            return result.ok ? null : "errors.commandUnavailable"
          } catch {
            return "errors.hostUnreachable"
          }
        }
        case "plugin-action":
          // The desktop's plugin modules are read-only here; the phone's own
          // run on the phone.
          if (paired) return "errors.commandUnavailable"
          return runGlancePluginAction(body.entryId, body.actionId)
        // The tray panel's own geometry and delegate bar: a phone has neither.
        case "set-max-height":
        case "set-width":
        case "set-delegate-visible":
          return "errors.requestFailed"
      }
    },
    [fromDesktop, local.quota, paired, petRemote, route, save, settings]
  )

  const glance = useMemo<GlanceContextValue>(
    () => ({
      snapshot,
      platform: "mobile",
      width: "standard",
      now: local.body.generatedAt,
      send,
      route,
      originOf,
    }),
    [snapshot, local.body.generatedAt, send, route, originOf]
  )

  return {
    settings,
    glance,
    originOf,
    remote,
    paired,
    supported,
    hostLayout: remote.snapshot?.hostLayout ?? null,
    pluginCatalog: snapshot.plugins?.catalog ?? NO_PLUGINS,
    save,
  }
}

const NO_PLUGINS: readonly GlancePluginCatalogEntry[] = []

/**
 * Pin or unpin one module on the phone's home screen, as a saved edit.
 * `plugins` are the plugin modules that can be pinned right now.
 */
export function pinnedLayout(
  settings: GlanceMobileSettings,
  id: GlanceEntryId,
  home: boolean,
  plugins: readonly GlanceEntryId[] = []
): GlanceMobileSettings {
  return withEditedMobileEntries(
    settings,
    pinEntryHome(settings.entries, id, home, [...glanceModulesFor("mobile"), ...plugins])
  )
}
