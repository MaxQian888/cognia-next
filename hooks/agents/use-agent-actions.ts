"use client"

/**
 * Every lifecycle action on an agent (ADR-0220), with the toast and the log
 * line each one owes the user. One hook so the agents table, the detail
 * header and its overflow menu run the same code: duplicate, variants
 * (create, detach, reset), pack updates (apply one, apply all, re-clone,
 * dismiss), pack export, bulk export and delete.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { Character } from "@cognia/agent-config-types"
import {
  CharacterHasVariantsError,
  applyPackUpdate,
  applyPackUpdateForPack,
  createCharacterVariant,
  deleteCharacter,
  detachCharacterVariant,
  dismissPackUpdate,
  duplicateCharacter,
  resetCharacterVariant,
} from "@/lib/db/characters"
import { listCharacterPackEntries } from "@/lib/plugin/registries/character-pack-registry"
import { characterToPackDef } from "@/lib/plugin/character-pack/editor-projection"
import { serializeLocalPackFile } from "@/lib/plugin/character-pack/schema"
import { describeAgentSource } from "@/lib/agents/agent-source"
import { downloadBlob } from "@/lib/files/download"
import { isTauri } from "@/lib/tauri"
import { createLogger } from "@cognia/logging"

const log = createLogger("agents.actions")

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface AgentActions {
  /** Resolves the copy, which callers usually open next. */
  duplicate: (agent: Character) => Promise<Character | undefined>
  createVariant: (agent: Character) => Promise<Character | undefined>
  detachVariant: (agent: Character) => Promise<void>
  resetVariant: (agent: Character) => Promise<void>
  /** Resolves `true` when the agent is gone. */
  remove: (agent: Character) => Promise<boolean>
  /** Deletes what it can; built-ins and overlay rows are skipped. Resolves the count deleted. */
  removeMany: (agents: readonly Character[]) => Promise<number>
  /** Downloads the chosen agents as one `.cognia-pack.json`. */
  exportMany: (agents: readonly Character[]) => void
  exportPack: (agent: Character) => Promise<void>
  recloneFromPack: (agent: Character) => Promise<Character | undefined>
  dismissUpdate: (agent: Character) => Promise<void>
  applyUpdateForPack: (agent: Character) => Promise<void>
  /** Opens the selective-overwrite confirmation for one clone. */
  requestApplyUpdate: (agent: Character) => void
  /** The clone the confirmation is open for. */
  applyUpdateTarget: Character | null
  confirmApplyUpdate: () => Promise<void>
  cancelApplyUpdate: () => void
}

export function useAgentActions(): AgentActions {
  const t = useTranslations("settings.characters")
  const [applyUpdateTarget, setApplyUpdateTarget] = useState<Character | null>(null)

  const duplicate = useCallback(
    async (agent: Character) => {
      try {
        const dup = await duplicateCharacter(agent.id)
        log.info("character_duplicated", { sourceId: agent.id, newId: dup.id })
        toast.success(t("duplicatedToast", { name: dup.name }))
        return dup
      } catch (err) {
        log.error("character_duplicate_failed", err, { id: agent.id })
        toast.error(message(err))
        return undefined
      }
    },
    [t]
  )

  const createVariant = useCallback(
    async (agent: Character) => {
      try {
        const variant = await createCharacterVariant(
          agent.id,
          t("variants.defaultName", { name: agent.name })
        )
        log.info("character_variant_created", { baseId: agent.id, id: variant.id })
        toast.success(t("variants.createdToast", { name: variant.name }))
        return variant
      } catch (err) {
        log.error("character_variant_create_failed", err, { id: agent.id })
        toast.error(message(err))
        return undefined
      }
    },
    [t]
  )

  const detachVariant = useCallback(
    async (agent: Character) => {
      try {
        await detachCharacterVariant(agent.id)
        log.info("character_variant_detached", { id: agent.id })
        toast.success(t("variants.detachedToast", { name: agent.name }))
      } catch (err) {
        log.error("character_variant_detach_failed", err, { id: agent.id })
        toast.error(message(err))
      }
    },
    [t]
  )

  const resetVariant = useCallback(
    async (agent: Character) => {
      try {
        await resetCharacterVariant(agent.id)
        log.info("character_variant_reset", { id: agent.id })
        toast.success(t("variants.resetToast", { name: agent.name }))
      } catch (err) {
        log.error("character_variant_reset_failed", err, { id: agent.id })
        toast.error(message(err))
      }
    },
    [t]
  )

  const remove = useCallback(
    async (agent: Character) => {
      try {
        await deleteCharacter(agent.id)
        log.info("character_deleted", { id: agent.id })
        toast.success(t("removedToast", { name: agent.name }))
        return true
      } catch (err) {
        log.error("character_delete_failed", err, { id: agent.id })
        toast.error(
          err instanceof CharacterHasVariantsError
            ? t("variants.deleteBlocked", {
                count: err.variantNames.length,
                names: err.variantNames.join(", "),
              })
            : message(err)
        )
        return false
      }
    },
    [t]
  )

  const removeMany = useCallback(
    async (agents: readonly Character[]) => {
      let deleted = 0
      for (const agent of agents) {
        try {
          await deleteCharacter(agent.id)
          deleted++
        } catch {
          // Built-in / plugin-overlay rows and bases with variants can't be
          // deleted — they are skipped, and the count says how many went.
        }
      }
      log.info("character_bulk_delete", { requested: agents.length, deleted })
      toast.success(t("bulk.deletedToast", { count: deleted }))
      return deleted
    },
    [t]
  )

  const exportMany = useCallback(
    (agents: readonly Character[]) => {
      if (agents.length === 0) return
      const pack = {
        id: `export-${Date.now()}`,
        name: t("bulk.exportPackName"),
        version: "1.0.0",
        characters: agents.map(characterToPackDef),
      }
      const json = serializeLocalPackFile(pack)
      const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")
      void downloadBlob(
        new Blob([json], { type: "application/json" }),
        `characters-${ts}.cognia-pack.json`
      )
      log.info("character_bulk_export", { count: agents.length })
      toast.success(t("bulk.exportedToast", { count: agents.length }))
    },
    [t]
  )

  const exportPack = useCallback(
    async (agent: Character) => {
      const packId = describeAgentSource(agent).packId
      if (!packId) {
        toast.error(t("exportPackUnavailable"))
        return
      }
      try {
        // Lazy: keeps the Tauri save dialog out of the bundle until exported.
        const { exportPack: exportLocalPack } =
          await import("@/lib/plugin/character-pack/local-pack-store")
        const result = exportLocalPack(packId)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        if (isTauri()) {
          const { save } = await import("@tauri-apps/plugin-dialog")
          const target = await save({
            defaultPath: result.value.filename,
            filters: [{ name: "Cognia Pack", extensions: ["json"] }],
          })
          if (!target) return
          const { writeTextFile } = await import("@tauri-apps/plugin-fs")
          await writeTextFile(target, result.value.body)
          toast.success(t("packs.exportedToast", { path: target }))
        } else {
          await downloadBlob(
            new Blob([result.value.body], { type: "application/json" }),
            result.value.filename
          )
          toast.success(t("packs.exportedToastBrowser"))
        }
      } catch (err) {
        log.error("character_export_pack_failed", err, { id: agent.id })
        toast.error(message(err))
      }
    },
    [t]
  )

  const recloneFromPack = useCallback(
    async (agent: Character) => {
      // ADR-0030 §D.3 — duplicate from the overlay synthetic id (the live
      // pack), then delete the stale Dexie row so one up-to-date clone remains.
      if (!agent.clonedFromPackCharacterId) return undefined
      try {
        const dup = await duplicateCharacter(agent.clonedFromPackCharacterId)
        await deleteCharacter(agent.id)
        log.info("character_recloned_from_pack", {
          staleId: agent.id,
          newId: dup.id,
          overlayId: agent.clonedFromPackCharacterId,
        })
        toast.success(t("recloneFromPackToast", { name: dup.name }))
        return dup
      } catch (err) {
        log.error("character_reclone_failed", err, { id: agent.id })
        toast.error(message(err))
        return undefined
      }
    },
    [t]
  )

  const dismissUpdate = useCallback(
    async (agent: Character) => {
      if (!agent.sourcePackId) return
      const entry = listCharacterPackEntries().find(
        (e) => e.entry.id === agent.sourcePackId && e.pluginId === agent.sourcePluginId
      )
      if (!entry) return
      try {
        await dismissPackUpdate(agent.id, entry.entry.version)
        log.info("character_pack_update_dismissed", {
          id: agent.id,
          pinnedVersion: entry.entry.version,
        })
        toast.success(t("dismissUpdateToast"))
      } catch (err) {
        log.error("character_dismiss_update_failed", err, { id: agent.id })
        toast.error(message(err))
      }
    },
    [t]
  )

  const applyUpdateForPack = useCallback(
    async (agent: Character) => {
      if (!agent.sourcePluginId || !agent.sourcePackId) return
      try {
        const results = await applyPackUpdateForPack(agent.sourcePluginId, agent.sourcePackId)
        const packName =
          listCharacterPackEntries().find(
            (e) => e.entry.id === agent.sourcePackId && e.pluginId === agent.sourcePluginId
          )?.entry.name ?? agent.sourcePackId
        log.info("character_pack_update_applied_batch", {
          sourcePluginId: agent.sourcePluginId,
          sourcePackId: agent.sourcePackId,
          count: results.length,
        })
        toast.success(t("applyUpdateToastBatch", { count: results.length, pack: packName }))
      } catch (err) {
        log.error("character_pack_update_apply_batch_failed", err, { id: agent.id })
        toast.error(message(err))
      }
    },
    [t]
  )

  const confirmApplyUpdate = useCallback(async () => {
    const target = applyUpdateTarget
    if (!target) return
    try {
      const result = await applyPackUpdate(target.id)
      if (!result) {
        toast.info(t("applyUpdateNoop", { name: target.name }))
      } else {
        log.info("character_pack_update_applied", {
          id: target.id,
          overwritten: result.overwrittenFields.length,
          preserved: result.preservedFields.length,
        })
        toast.success(
          t("applyUpdateToast", {
            name: target.name,
            updated: result.overwrittenFields.length,
            preserved: result.preservedFields.length,
          })
        )
      }
    } catch (err) {
      log.error("character_pack_update_apply_failed", err, { id: target.id })
      toast.error(message(err))
    } finally {
      setApplyUpdateTarget(null)
    }
  }, [applyUpdateTarget, t])

  return {
    duplicate,
    createVariant,
    detachVariant,
    resetVariant,
    remove,
    removeMany,
    exportMany,
    exportPack,
    recloneFromPack,
    dismissUpdate,
    applyUpdateForPack,
    requestApplyUpdate: setApplyUpdateTarget,
    applyUpdateTarget,
    confirmApplyUpdate,
    cancelApplyUpdate: () => setApplyUpdateTarget(null),
  }
}
