"use client"

/**
 * Production wiring for the Update Center.
 *
 * Everything above this file is injectable and testable. This is the one place
 * that binds the coordinator to the real settings store, the real catalog
 * endpoint, and the real installers, so a test never has to touch any of them.
 */

import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  type UpdateCenterSettings,
} from "@cognia/agent-config-types"

import { APP_VERSION } from "@/lib/app-version"
import { loggers } from "@/lib/logging"
import { isNativeMobile } from "@/lib/platform/detect"
import { detectOsFamily } from "@/lib/platform/os"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"

import type { UpdateAdapter } from "./adapter"
import { createBrowserExtensionAdapter } from "./adapters/browser-extension-adapter"
import { createCharacterPackAdapter } from "./adapters/character-pack-adapter"
import { createCliAdapter } from "./adapters/cli-adapter"
import { createDesktopAdapter } from "./adapters/desktop-adapter"
import { createMobileAdapter } from "./adapters/mobile-adapter"
import { createPluginAdapter } from "./adapters/plugin-adapter"
import { createSkillAdapter } from "./adapters/skill-adapter"
import { fetchVerifiedCatalog } from "./catalog-client"
import { UpdateCoordinator, type UpdatePersistence } from "./coordinator"
import { openUpdateCenter } from "./open-update-center"

/** Read the current Update Center settings out of the hydrated settings store. */
export function readUpdateCenterSettings(): UpdateCenterSettings {
  const raw = useSettingsStore.getState().settings?.updateCenter
  return { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...(raw ?? {}) }
}

function settingsPersistence(): UpdatePersistence {
  return {
    read: readUpdateCenterSettings,
    async write(patch) {
      const current = readUpdateCenterSettings()
      await useSettingsStore.getState().save({ updateCenter: { ...current, ...patch } })
    },
  }
}

/** Adapters that exist on this host, already bound to their real backends. */
export function productionAdapters(): UpdateAdapter[] {
  return [
    createDesktopAdapter(),
    createMobileAdapter("mobile-ios", { playCore: undefined }),
    createMobileAdapter("mobile-android", {
      playCore: {
        getAppUpdateInfo: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.getAppUpdateInfo(...args)),
        startFlexibleUpdate: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.startFlexibleUpdate(...args)),
        completeFlexibleUpdate: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.completeFlexibleUpdate(...args)),
        performImmediateUpdate: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.performImmediateUpdate(...args)),
        openAppStore: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.openAppStore(...args)),
      },
    }),
    createBrowserExtensionAdapter("browser-chrome", { isSupported: () => isTauri() }),
    createBrowserExtensionAdapter("browser-edge", { isSupported: () => isTauri() }),
    createCliAdapter({
      isSupported: () => isTauri(),
      installedVersion: async () => {
        const { detectInstalledCli } = await import("./cli-presence")
        return (await detectInstalledCli()).version
      },
      packageManager: async () => {
        const { detectInstalledCli } = await import("./cli-presence")
        return (await detectInstalledCli()).manager
      },
    }),
    createPluginAdapter({ isSupported: () => !isNativeMobile() }),
    createSkillAdapter({
      isSupported: () => true,
      checkAll: async () => {
        const [{ listSkills }, { checkSkillsShUpdates }] = await Promise.all([
          import("@/lib/db/skills"),
          import("@/lib/skills/skillssh-updates"),
        ])
        const skills = await listSkills()
        const statuses = await checkSkillsShUpdates(skills)
        const byId = new Map(skills.map((s) => [s.id, s]))
        return statuses.map((status) => ({
          skillId: status.skillId,
          canonicalId: status.canonicalId,
          name: byId.get(status.skillId)?.name ?? status.skillId,
          hasUpdate: status.hasUpdate,
          currentHash: status.currentHash,
          remoteHash: status.remoteHash,
          error: status.error,
        }))
      },
      updateOne: async (skillId) => {
        const [{ listSkills }, { marketplaceItemFromSkill }, { installMarketplaceItem }] =
          await Promise.all([
            import("@/lib/db/skills"),
            import("@/lib/skills/skillssh-updates"),
            import("@/lib/skills/marketplace-install"),
          ])
        const skill = (await listSkills()).find((s) => s.id === skillId)
        const item = skill ? marketplaceItemFromSkill(skill) : null
        if (!item) throw new Error("skill was not installed from a remote source")
        await installMarketplaceItem(item)
      },
    }),
    createCharacterPackAdapter({
      isSupported: () => true,
      listPacks: async () => {
        const { listCharacters, previewPackUpdate } = await import("@/lib/db/characters")
        const rows = await listCharacters()
        const packs = []
        for (const row of rows) {
          if (!row.sourcePluginId || !row.sourcePackId) continue
          const preview = await previewPackUpdate(row.id)
          if (!preview) continue
          packs.push({
            characterId: row.id,
            displayName: row.name,
            pluginId: row.sourcePluginId,
            appliedVersion: row.packVersionAtClone ?? "unknown",
            availableVersion: preview.packVersion,
            userEditedFields: preview.diff.preserved.length,
          })
        }
        return packs
      },
      openDiff: async (characterId) => {
        openUpdateCenter({ packDiffCharacterId: characterId })
      },
    }),
  ]
}

let singleton: UpdateCoordinator | null = null

/** The app-wide coordinator. Created once, on first use. */
export function getUpdateCoordinator(): UpdateCoordinator {
  if (singleton) return singleton
  singleton = new UpdateCoordinator({
    adapters: productionAdapters(),
    persistence: settingsPersistence(),
    appVersion: APP_VERSION,
    fetchCatalog: async ({ channel, signal }) => {
      const settings = readUpdateCenterSettings()
      const result = await fetchVerifiedCatalog(
        { channel, rolloutBucket: settings.rolloutBucket ?? 0, signal },
        {
          catalogUrl: settings.catalogUrl,
          platform: detectOsFamily(),
          onError: (error) =>
            loggers.app.debug("updates.catalogUnavailable", { error: String(error) }),
        }
      )
      return result
    },
    checkIntervalMs: () => {
      const minutes = useSettingsStore.getState().settings?.updates?.checkIntervalMinutes
      return (typeof minutes === "number" ? minutes : 6 * 60) * 60 * 1000
    },
    telemetry: (event) => loggers.app.info("updates.attempt", { ...event }),
    onError: (scope, error) => loggers.app.warn("updates.error", { scope, error: String(error) }),
  })
  return singleton
}

/** Test-only: drop the singleton so a fresh wiring is built. */
export function __resetUpdateCoordinator(): void {
  singleton?.__reset()
  singleton = null
}
