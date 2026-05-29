"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  applyPackUpdate,
  applyPackUpdateForPack,
  createCharacter,
  deleteCharacter,
  dismissPackUpdate,
  duplicateCharacter,
  listCharacters,
  updateCharacter,
} from "@/lib/db/characters"
import { CharacterPackUpdateDialog } from "@/components/settings/character-pack-update-dialog"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listSkills } from "@/lib/db/skills"
import type { AppSettings, Character, McpServer, Skill } from "@/lib/claude/types"
// ADR-0020 W2 — Computer Use sub-settings UI reads the live native-tool
// registry so allowedToolIds is a real picker (one checkbox per
// registered tool) instead of a free-form text field. `listEntries`
// returns the same shape `applyComputerUseTools` filters against.
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
// ADR-0030 — Character pack overlay + local-imported pack file support.
import {
  getPackCharacterWarnings,
  getPackWarnings,
  isOverlayCharacterId,
  listCharacterPackEntries,
} from "@/lib/plugin/registries/character-pack-registry"
import type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"
import {
  deleteLocalPack,
  importLocalPack,
  LOCAL_PACK_PLUGIN_ID,
} from "@/lib/plugin/character-pack/local-pack-store"
import { usePluginMetadata } from "@/hooks/plugins/use-plugin-metadata"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { isTauri } from "@/lib/tauri"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { TestTtsButton } from "@/components/settings/speech/test-tts-button"
import { resolveCharacterVoice } from "@/lib/plugin/character-pack/character-voice"
import { buildPersona, buildVoiceProfile } from "@/lib/plugin/character-pack/editor-projection"
import type {
  PluginCharacterAvatarImage,
  PluginCharacterPersona,
  PluginCharacterVoiceProfile,
} from "@/types/plugin/plugin-character-pack"
import type { PluginRuntimeProfile } from "@/types/plugin/plugin"
import {
  TTS_PROVIDERS,
  type TTSProvider,
  OPENAI_TTS_VOICES,
  GEMINI_TTS_VOICES,
  EDGE_TTS_VOICES,
  ELEVENLABS_TTS_VOICES,
  LMNT_TTS_VOICES,
  HUME_TTS_VOICES,
  CARTESIA_TTS_VOICES,
  DEEPGRAM_TTS_VOICES,
  XIAOMI_TTS_VOICES,
} from "@/lib/tts/types"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  TwinBindingSection,
  type TwinBindingValue,
} from "@/components/settings/character/twin-binding-section"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CheckSquareIcon,
  CopyIcon,
  DownloadIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Checkbox } from "@/components/ui/checkbox"
import { characterToPackDef, filterCharacters } from "@/lib/plugin/character-pack/editor-projection"
import { serializeLocalPackFile } from "@/lib/plugin/character-pack/schema"
import { downloadBlob } from "@/lib/files/download"
import { createLogger } from "@/lib/logging"
import { MODEL_PRESET_VALUES, PERMISSION_MODE_VALUES } from "@/lib/claude/model-presets"
import { useUIStore } from "@/stores/ui/ui-store"

const log = createLogger("settings.characters")

const COLOR_PALETTE = [
  "oklch(0.65 0.18 245)",
  "oklch(0.7 0.15 30)",
  "oklch(0.7 0.13 150)",
  "oklch(0.78 0.16 90)",
  "oklch(0.7 0.14 320)",
  "oklch(0.7 0.16 200)",
  "oklch(0.65 0.18 350)",
  "oklch(0.7 0.14 60)",
]

// ADR-0030 v2 — per-character voice profile editor support. Reuses the
// existing TTS voice catalogs (`lib/tts/types.ts`). `system` has no static
// catalog (browser voices load at runtime), so its voiceId is free-text.
const VOICE_CATALOG: Partial<Record<TTSProvider, ReadonlyArray<{ id: string; name: string }>>> = {
  openai: OPENAI_TTS_VOICES,
  gemini: GEMINI_TTS_VOICES,
  edge: EDGE_TTS_VOICES,
  elevenlabs: ELEVENLABS_TTS_VOICES,
  lmnt: LMNT_TTS_VOICES,
  hume: HUME_TTS_VOICES,
  cartesia: CARTESIA_TTS_VOICES,
  deepgram: DEEPGRAM_TTS_VOICES,
  xiaomi: XIAOMI_TTS_VOICES,
}

const PLATFORM_OPTIONS: PluginRuntimeProfile[] = ["tauri", "browser"]

/** Labelled 0.05-step slider for the voice rate / pitch / volume controls. */
function VoiceSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={0.05}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
      />
    </div>
  )
}

export function CharactersSection() {
  const t = useTranslations("settings.characters")
  const charactersRaw = useLiveQuery(() => listCharacters(), [])
  const characters = useMemo(() => charactersRaw ?? [], [charactersRaw])
  const skills = useLiveQuery(() => listSkills(), []) ?? []
  const mcpServers = useLiveQuery(() => listMcpServers(), []) ?? []
  const [editing, setEditing] = useState<Character | null>(null)
  const [creating, setCreating] = useState(false)
  const [applyUpdateTarget, setApplyUpdateTarget] = useState<Character | null>(null)
  // C2 — search + source filter. C3 — multi-select bulk delete / export.
  const [query, setQuery] = useState("")
  const [sourceFilter, setSourceFilter] = useState<"all" | "builtin" | "plugin" | "user">("all")
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  const filtered = useMemo(
    () => filterCharacters(characters, query, sourceFilter),
    [characters, query, sourceFilter]
  )

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }, [])

  const bulkDelete = useCallback(async () => {
    const ids = [...selectedIds]
    let deleted = 0
    for (const id of ids) {
      try {
        await deleteCharacter(id)
        deleted++
      } catch {
        // Built-in / plugin-overlay rows can't be deleted — skip silently.
      }
    }
    log.info("character_bulk_delete", { requested: ids.length, deleted })
    toast.success(t("bulk.deletedToast", { count: deleted }))
    exitSelection()
  }, [selectedIds, t, exitSelection])

  const bulkExport = useCallback(() => {
    const chosen = characters.filter((c) => selectedIds.has(c.id))
    if (chosen.length === 0) return
    const pack = {
      id: `export-${Date.now()}`,
      name: t("bulk.exportPackName"),
      version: "1.0.0",
      characters: chosen.map(characterToPackDef),
    }
    const json = serializeLocalPackFile(pack)
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")
    downloadBlob(
      new Blob([json], { type: "application/json" }),
      `characters-${ts}.cognia-pack.json`
    )
    log.info("character_bulk_export", { count: chosen.length })
    toast.success(t("bulk.exportedToast", { count: chosen.length }))
  }, [characters, selectedIds, t])

  // Count clones-with-pending-update per pack so each row can decide
  // whether to surface the "Apply to all" batch button (≥2). Recomputed
  // whenever the character list changes; the overlay-registry side
  // (`listCharacterPackEntries()`) is in-memory and effectively free.
  const pendingUpdateByPack = useMemo(() => {
    const map = new Map<string, number>()
    const entries = listCharacterPackEntries()
    for (const c of characters) {
      if (!c.sourcePluginId || !c.sourcePackId || !c.packVersionAtClone) continue
      const live = entries.find(
        (e) => e.entry.id === c.sourcePackId && e.pluginId === c.sourcePluginId
      )?.entry.version
      if (!live || live === c.packVersionAtClone) continue
      const key = `${c.sourcePluginId}:${c.sourcePackId}`
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [characters])

  // Honor the File → New Character menu item: when the ui-store flags a
  // character-create request, pop the creation form and clear the signal.
  const pendingCreate = useUIStore((s) => s.pendingCreateRequest)
  const clearPendingCreate = useUIStore((s) => s.clearPendingCreate)
  useEffect(() => {
    if (pendingCreate?.kind === "character") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- WIP: deriving from pendingCreate would be cleaner; revisit when this section stabilises.
      setCreating(true)
      clearPendingCreate()
    }
  }, [pendingCreate, clearPendingCreate])

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <UsersRoundIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null)
            setCreating(true)
          }}
        >
          <PlusIcon className="mr-2 size-4" />
          {t("newCharacter")}
        </Button>
      </div>

      <CharacterPacksSubsection />

      {characters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[10rem] flex-1">
            <SearchIcon className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 pl-7 text-sm"
              aria-label={t("searchPlaceholder")}
            />
          </div>
          <Select
            value={sourceFilter}
            onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}
          >
            <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label={t("filter.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filter.all")}</SelectItem>
              <SelectItem value="builtin">{t("filter.builtin")}</SelectItem>
              <SelectItem value="plugin">{t("filter.plugin")}</SelectItem>
              <SelectItem value="user">{t("filter.user")}</SelectItem>
            </SelectContent>
          </Select>
          {selectionMode ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={selectedIds.size === 0}
                onClick={() => void bulkDelete()}
              >
                <Trash2Icon className="mr-1 size-4" />
                {t("bulk.deleteSelected", { count: selectedIds.size })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={selectedIds.size === 0}
                onClick={bulkExport}
              >
                <DownloadIcon className="mr-1 size-4" />
                {t("bulk.exportSelected", { count: selectedIds.size })}
              </Button>
              <Button size="sm" variant="ghost" onClick={exitSelection}>
                <XIcon className="mr-1 size-4" />
                {t("bulk.done")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setSelectionMode(true)}>
              <CheckSquareIcon className="mr-1 size-4" />
              {t("bulk.select")}
            </Button>
          )}
        </div>
      )}

      {characters.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("emptyHint")}
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("noMatches")}
        </p>
      ) : (
        <div className="grid gap-2">
          {filtered.map((c) => (
            <CharacterRow
              key={c.id}
              character={c}
              skills={skills}
              editing={editing?.id === c.id}
              onEditStart={() => setEditing(c)}
              onEditCancel={() => setEditing(null)}
              skillsCatalog={skills}
              mcpCatalog={mcpServers}
              selectionMode={selectionMode}
              selected={selectedIds.has(c.id)}
              onToggleSelect={() => toggleSelect(c.id)}
              siblingPendingCount={
                c.sourcePluginId && c.sourcePackId
                  ? (pendingUpdateByPack.get(`${c.sourcePluginId}:${c.sourcePackId}`) ?? 0)
                  : 0
              }
              onSave={async (patch) => {
                try {
                  await updateCharacter(c.id, patch)
                  log.info("character_updated", { id: c.id })
                  setEditing(null)
                  toast.success(t("updatedToast", { name: patch.name ?? c.name }))
                } catch (err) {
                  log.error("character_update_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onDelete={async () => {
                try {
                  await deleteCharacter(c.id)
                  log.info("character_deleted", { id: c.id })
                  toast.success(t("removedToast", { name: c.name }))
                } catch (err) {
                  log.error("character_delete_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onDuplicate={async () => {
                try {
                  const dup = await duplicateCharacter(c.id)
                  log.info("character_duplicated", { sourceId: c.id, newId: dup.id })
                  toast.success(t("duplicatedToast", { name: dup.name }))
                  setEditing(dup)
                } catch (err) {
                  log.error("character_duplicate_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onRecloneFromPack={async () => {
                // ADR-0030 §D.3 — duplicate from the overlay synthetic id
                // (the live pack), then delete the stale Dexie row so the
                // user has a single up-to-date clone.
                if (!c.clonedFromPackCharacterId) return
                try {
                  const dup = await duplicateCharacter(c.clonedFromPackCharacterId)
                  await deleteCharacter(c.id)
                  log.info("character_recloned_from_pack", {
                    staleId: c.id,
                    newId: dup.id,
                    overlayId: c.clonedFromPackCharacterId,
                  })
                  toast.success(t("recloneFromPackToast", { name: dup.name }))
                  setEditing(dup)
                } catch (err) {
                  log.error("character_reclone_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onDismissUpdate={async () => {
                if (!c.sourcePackId) return
                const entry = listCharacterPackEntries().find(
                  (e) => e.entry.id === c.sourcePackId && e.pluginId === c.sourcePluginId
                )
                if (!entry) return
                try {
                  await dismissPackUpdate(c.id, entry.entry.version)
                  log.info("character_pack_update_dismissed", {
                    id: c.id,
                    pinnedVersion: entry.entry.version,
                  })
                  toast.success(t("dismissUpdateToast"))
                } catch (err) {
                  log.error("character_dismiss_update_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onApplyUpdate={() => setApplyUpdateTarget(c)}
              onApplyUpdateForPack={async () => {
                if (!c.sourcePluginId || !c.sourcePackId) return
                try {
                  const results = await applyPackUpdateForPack(c.sourcePluginId, c.sourcePackId)
                  const packName =
                    listCharacterPackEntries().find(
                      (e) => e.entry.id === c.sourcePackId && e.pluginId === c.sourcePluginId
                    )?.entry.name ?? c.sourcePackId
                  log.info("character_pack_update_applied_batch", {
                    sourcePluginId: c.sourcePluginId,
                    sourcePackId: c.sourcePackId,
                    count: results.length,
                  })
                  toast.success(
                    t("applyUpdateToastBatch", { count: results.length, pack: packName })
                  )
                } catch (err) {
                  log.error("character_pack_update_apply_batch_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onExportPack={async () => {
                // Resolve the pack id from the row: overlay rows parse it
                // from their synthetic id; cloned rows use sourcePackId.
                let packId: string | undefined
                if (isOverlayCharacterId(c.id)) {
                  packId = c.id.slice("cognia-pack:".length).split(":")[1]
                } else if (c.sourcePackId) {
                  packId = c.sourcePackId
                }
                if (!packId) {
                  toast.error(t("exportPackUnavailable"))
                  return
                }
                try {
                  // Lazy import to avoid pulling the Tauri save dialog into
                  // the renderer bundle for non-export paths.
                  const { exportPack } =
                    await import("@/lib/plugin/character-pack/local-pack-store")
                  const result = exportPack(packId)
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
                    // Browser fallback — trigger a download via a Blob link.
                    const blob = new Blob([result.value.body], { type: "application/json" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = result.value.filename
                    a.click()
                    URL.revokeObjectURL(url)
                    toast.success(t("packs.exportedToastBrowser"))
                  }
                } catch (err) {
                  log.error("character_export_pack_failed", err, { id: c.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
            />
          ))}
        </div>
      )}

      <CharacterPackUpdateDialog
        open={applyUpdateTarget !== null}
        characterId={applyUpdateTarget?.id ?? null}
        characterName={applyUpdateTarget?.name ?? ""}
        onCancel={() => setApplyUpdateTarget(null)}
        onConfirm={async () => {
          if (!applyUpdateTarget) return
          try {
            const result = await applyPackUpdate(applyUpdateTarget.id)
            if (!result) {
              toast.info(t("applyUpdateNoop", { name: applyUpdateTarget.name }))
            } else {
              log.info("character_pack_update_applied", {
                id: applyUpdateTarget.id,
                overwritten: result.overwrittenFields.length,
                preserved: result.preservedFields.length,
              })
              toast.success(
                t("applyUpdateToast", {
                  name: applyUpdateTarget.name,
                  updated: result.overwrittenFields.length,
                  preserved: result.preservedFields.length,
                })
              )
            }
          } catch (err) {
            log.error("character_pack_update_apply_failed", err, { id: applyUpdateTarget.id })
            toast.error(err instanceof Error ? err.message : String(err))
          } finally {
            setApplyUpdateTarget(null)
          }
        }}
      />

      {creating && (
        <CharacterEditor
          initial={{
            name: "",
            description: "",
            avatarColor: COLOR_PALETTE[0],
            avatarEmoji: "✨",
            systemPrompt: "",
            model: "",
            permissionMode: undefined,
            allowedTools: [],
            disallowedTools: [],
            mcpServerIds: undefined,
            skillIds: [],
            workingDir: "",
            bareMode: false,
            debugMode: false,
            briefMode: false,
            twinId: undefined,
            twinSettings: undefined,
            enableComputerUse: false,
            computerUseSettings: undefined,
            computerUseTarget: "local",
            sandboxEnabled: false,
            sandboxTier: "inherit",
            accountIdOverride: "inherit",
            personaTone: "",
            personaPersonality: "",
            openingMessage: "",
            exemplarPromptsText: "",
            avatarImageDataUrl: "",
            voiceProvider: "none",
            voiceId: "",
            voiceRate: 1,
            voicePitch: 1,
            voiceVolume: 1,
            availablePlatforms: [],
          }}
          skillsCatalog={skills}
          mcpCatalog={mcpServers}
          submitLabel={t("create")}
          onCancel={() => setCreating(false)}
          onSave={async (data) => {
            try {
              await createCharacter(data)
              log.info("character_created", { name: data.name })
              setCreating(false)
              toast.success(t("addedToast", { name: data.name }))
            } catch (err) {
              log.error("character_create_failed", err)
              toast.error(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}
    </div>
  )
}

interface RowProps {
  character: Character
  skills: Skill[]
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: EditorOutput) => Promise<void>
  onDelete: () => Promise<void>
  onDuplicate: () => Promise<void>
  /** Re-clone from the current overlay-registered pack (ADR-0030 §D.3). */
  onRecloneFromPack: () => Promise<void>
  /** Snap `packVersionAtClone` to current pack.version to silence the badge. */
  onDismissUpdate: () => Promise<void>
  /** Export the source pack (overlay or cloned) as a `.cognia-pack.json`. */
  onExportPack: () => Promise<void>
  /** ADR-0030 v50 — open the selective-overwrite confirm dialog. */
  onApplyUpdate: () => void
  /** ADR-0030 v50 — apply to every clone of the same pack at once. */
  onApplyUpdateForPack: () => Promise<void>
  /** Number of *other* clones from the same pack pending an update. Drives the batch button. */
  siblingPendingCount: number
  /** Bulk-selection mode — renders a leading checkbox and suppresses inline actions. */
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}

function CharacterRow({
  character,
  skills,
  skillsCatalog,
  mcpCatalog,
  editing,
  onEditStart,
  onEditCancel,
  onSave,
  onDelete,
  onDuplicate,
  onRecloneFromPack,
  onDismissUpdate,
  onExportPack,
  onApplyUpdate,
  onApplyUpdateForPack,
  siblingPendingCount,
  selectionMode,
  selected,
  onToggleSelect,
}: RowProps) {
  const t = useTranslations("settings.characters")
  // Hook calls must precede the editing-mode early return below to keep
  // the call order stable across renders (rules-of-hooks).
  const sourcePluginId = character.sourcePluginId
  const pluginMeta = usePluginMetadata(sourcePluginId)
  if (editing) {
    return (
      <CharacterEditor
        editingId={character.id}
        initial={{
          name: character.name,
          description: character.description ?? "",
          avatarColor: character.avatarColor,
          avatarEmoji: character.avatarEmoji ?? "",
          systemPrompt: character.systemPrompt,
          model: character.model ?? "",
          permissionMode: character.permissionMode,
          allowedTools: character.allowedTools ?? [],
          disallowedTools: character.disallowedTools ?? [],
          mcpServerIds: character.mcpServerIds,
          skillIds: character.skillIds ?? [],
          workingDir: character.workingDir ?? "",
          bareMode: Boolean(character.bareMode),
          debugMode: Boolean(character.debugMode),
          briefMode: Boolean(character.briefMode),
          twinId: character.twinId,
          twinSettings: character.twinSettings,
          enableComputerUse: Boolean(character.enableComputerUse),
          computerUseSettings: character.computerUseSettings,
          computerUseTarget:
            character.computerUseTarget && typeof character.computerUseTarget === "object"
              ? character.computerUseTarget.connectionId
              : "local",
          sandboxEnabled: Boolean(character.sandboxEnabled),
          sandboxTier: character.sandboxTier ?? "inherit",
          accountIdOverride: character.accountIdOverride ?? "inherit",
          personaTone: character.persona?.tone ?? "",
          personaPersonality: character.persona?.personality ?? "",
          openingMessage: character.persona?.openingMessage ?? "",
          exemplarPromptsText: (character.persona?.exemplarPrompts ?? []).join("\n"),
          avatarImageDataUrl: character.avatarImage?.webDataUrl ?? "",
          voiceProvider: character.voiceProfile?.provider ?? "none",
          voiceId: character.voiceProfile?.voiceId ?? "",
          voiceRate: character.voiceProfile?.rate ?? 1,
          voicePitch: character.voiceProfile?.pitch ?? 1,
          voiceVolume: character.voiceProfile?.volume ?? 1,
          availablePlatforms: character.availableOnPlatforms ?? [],
        }}
        skillsCatalog={skillsCatalog}
        mcpCatalog={mcpCatalog}
        submitLabel={t("save")}
        onCancel={onEditCancel}
        onSave={onSave}
      />
    )
  }

  const skillCount = (character.skillIds ?? []).length
  const skillNames = (character.skillIds ?? [])
    .map((id) => skills.find((s) => s.id === id)?.name)
    .filter(Boolean)
    .join(", ")

  // ADR-0030 row-source classification. Three orthogonal facts drive
  // the badge set and the action gating:
  //   - isOverlay: synthetic id, not a Dexie row (plugin / local-pack)
  //   - isCloned: Dexie row carrying sourcePluginId attribution
  //   - showUpdateAvailable: clone whose pack version moved
  const isOverlay = isOverlayCharacterId(character.id)
  const isCloned = !isOverlay && Boolean(character.sourcePluginId)
  const sourceLabel = isOverlay
    ? sourcePluginId === LOCAL_PACK_PLUGIN_ID || !sourcePluginId
      ? t("badge.fromLocalFile")
      : t("badge.fromPlugin", { name: pluginMeta?.name ?? sourcePluginId })
    : isCloned
      ? sourcePluginId === LOCAL_PACK_PLUGIN_ID
        ? t("badge.clonedFromLocalFile")
        : t("badge.cloned", { name: pluginMeta?.name ?? sourcePluginId ?? "" })
      : null
  // Update-available comparison runs on cloned rows whose source pack is
  // still registered. We look up the live pack via listCharacterPackEntries
  // (a Map iteration, O(N) over registered packs — fine for the typical
  // ~10 packs case). When the pack is unregistered (plugin disabled,
  // local file deleted) we leave the clone alone — no orphan badge.
  const livePackVersion =
    isCloned && character.sourcePackId
      ? listCharacterPackEntries().find(
          (e) => e.entry.id === character.sourcePackId && e.pluginId === character.sourcePluginId
        )?.entry.version
      : undefined
  const showUpdateAvailable =
    isCloned &&
    Boolean(character.packVersionAtClone) &&
    Boolean(livePackVersion) &&
    livePackVersion !== character.packVersionAtClone

  // ADR-0030 §B.6 — surface `requires` warnings stamped at register time.
  // Overlay rows query their pack via the synthetic id (parsed via the
  // overlay-id format); cloned Dexie rows query their pack via the source
  // attribution fields. Either way the warnings come from the same
  // `getPackCharacterWarnings` / `getPackWarnings` accessors.
  let warnings: readonly PluginCharacterPackWarning[] = []
  if (isOverlay) {
    const idSegments = character.id.slice("cognia-pack:".length).split(":")
    const packId = idSegments[1]
    const localId = idSegments.slice(2).join(":")
    if (packId && localId) warnings = getPackCharacterWarnings(packId, localId)
  } else if (isCloned && character.sourcePackId) {
    warnings = getPackWarnings(character.sourcePackId)
  }
  const warningTitle = warnings
    .map((w) =>
      w.characterLocalId
        ? `${w.code} (${w.characterLocalId}): ${w.missingId}`
        : `${w.code}: ${w.missingId}`
    )
    .join("\n")

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        {selectionMode && (
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect?.()}
            aria-label={t("bulk.selectRow", { name: character.name })}
            className="mt-1"
          />
        )}
        <AvatarBadge
          subject={{ ...character, avatarImageUrl: character.avatarImage?.webDataUrl }}
          size={40}
          textClassName="text-base"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{character.name}</p>
            {character.isBuiltIn && (
              <Badge variant="secondary" className="text-[10px]">
                {t("builtIn")}
              </Badge>
            )}
            {sourceLabel && (
              <Badge
                variant="outline"
                className="text-[10px]"
                title={pluginMeta?.id ?? sourcePluginId}
              >
                {sourceLabel}
              </Badge>
            )}
            {showUpdateAvailable && (
              <>
                <Badge
                  variant="outline"
                  className="border-yellow-500/40 bg-yellow-500/10 text-[10px] text-yellow-700 dark:text-yellow-300"
                >
                  {t("badge.updateAvailable")}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-yellow-700 hover:text-yellow-800 dark:text-yellow-300"
                  onClick={onApplyUpdate}
                  title={t("actions.applyUpdateTitle")}
                >
                  {t("actions.applyUpdate")}
                </Button>
                {siblingPendingCount >= 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] text-yellow-700 hover:text-yellow-800 dark:text-yellow-300"
                    onClick={() => void onApplyUpdateForPack()}
                    title={t("actions.applyUpdateBatchTitle")}
                  >
                    {t("actions.applyUpdateBatch", { count: siblingPendingCount })}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-yellow-700 hover:text-yellow-800 dark:text-yellow-300"
                  onClick={() => void onRecloneFromPack()}
                  title={t("actions.recloneFromPackTitle")}
                >
                  {t("actions.recloneFromPack")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground"
                  onClick={() => void onDismissUpdate()}
                  title={t("actions.dismissUpdateTitle")}
                >
                  {t("actions.dismissUpdate")}
                </Button>
              </>
            )}
            {warnings.length > 0 && (
              <Badge
                variant="outline"
                className="border-yellow-500/40 bg-yellow-500/10 text-[10px] text-yellow-700 dark:text-yellow-300"
                title={warningTitle}
              >
                {t("badge.missingDep", { count: warnings.length })}
              </Badge>
            )}
            {character.model && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {character.model}
              </Badge>
            )}
          </div>
          {character.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{character.description}</p>
          )}
          {skillCount > 0 && (
            <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
              {t("skillsCount", { count: skillCount })}
              {skillNames && `: ${skillNames}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            aria-label={t("editAria", { name: character.name })}
            disabled={character.isBuiltIn || isOverlay}
            title={
              character.isBuiltIn
                ? t("builtInReadOnly")
                : isOverlay
                  ? t("overlayReadOnly")
                  : t("edit")
            }
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void onDuplicate()}
            aria-label={t("duplicateAria", { name: character.name })}
            title={t("duplicate")}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          {(isOverlay || isCloned) && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void onExportPack()}
              aria-label={t("exportPackAria", { name: character.name })}
              title={t("actions.exportPack")}
            >
              <DownloadIcon className="size-3.5" />
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                aria-label={t("deleteAria", { name: character.name })}
                disabled={character.isBuiltIn || isOverlay}
                title={
                  character.isBuiltIn
                    ? t("builtInUndeletable")
                    : isOverlay
                      ? t("overlayUndeletable")
                      : t("delete")
                }
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("removeBody", { name: character.name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onDelete()}>{t("remove")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </Card>
  )
}

// ===========================================================================
// ADR-0030 — Character packs subsection (overlay registry view + local
// pack import). Lives inline above the character list so users can see
// where each pack came from without an extra navigation step.
// ===========================================================================

function CharacterPacksSubsection() {
  const t = useTranslations("settings.characters")
  // Subscribe to plugin state so the subsection re-renders when a plugin
  // enables/disables (the overlay registry changes synchronously with
  // the store). We read pack entries inside the render path — the call
  // is cheap and the registry only mutates on enable/disable, never per
  // keystroke.
  const _pluginCount = usePluginStore((s) => Object.keys(s.plugins).length)
  void _pluginCount
  // Force re-render on every store change. We don't read the data via
  // the selector because the registry isn't part of the Zustand state —
  // it's a separate in-memory Map updated by the plugin manager. The
  // selector subscription serves purely as a "something changed" tick.
  const packs = listCharacterPackEntries()

  const handleImport = async () => {
    if (!isTauri()) {
      toast.error(t("packs.importUnavailableWeb"))
      return
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selection = await open({
        multiple: false,
        filters: [{ name: "Cognia Pack", extensions: ["json"] }],
      })
      if (!selection || typeof selection !== "string") return
      const { readTextFile } = await import("@tauri-apps/plugin-fs")
      const body = await readTextFile(selection)
      const result = await importLocalPack(body)
      if (result.ok) {
        toast.success(t("packs.importedToast", { id: result.value.packId }))
      } else {
        toast.error(result.error)
      }
    } catch (err) {
      log.error("pack_import_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRescan = async () => {
    try {
      const { scanAndRegisterLocalPacks } =
        await import("@/lib/plugin/character-pack/local-pack-store")
      const result = await scanAndRegisterLocalPacks()
      log.info("pack_rescan_done", {
        registered: result.registered.length,
        skipped: result.skipped.length,
      })
      toast.success(
        t("packs.rescanToast", {
          registered: result.registered.length,
          skipped: result.skipped.length,
        })
      )
    } catch (err) {
      log.error("pack_rescan_failed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (packs.length === 0) {
    // Don't render the accordion at all when there are no packs —
    // the Import button moves into the main toolbar so users still
    // have a discoverable affordance. We render that affordance
    // alongside the empty hint below.
    if (!isTauri()) return null
    return (
      <div className="flex items-center justify-between rounded-md border border-dashed p-3">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">{t("packs.title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("packs.emptyHint")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void handleImport()}>
          <UploadIcon className="mr-2 size-3.5" />
          {t("packs.importJsonAction")}
        </Button>
      </div>
    )
  }

  return (
    <Accordion type="single" collapsible defaultValue="packs">
      <AccordionItem value="packs">
        <AccordionTrigger className="text-sm">
          <span className="flex items-center gap-2">
            <PackageIcon className="size-4" />
            {t("packs.title")}
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {packs.length}
            </Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-2">
          {packs.map((entry) => (
            <PackRow
              key={`${entry.pluginId ?? ""}:${entry.id}`}
              packId={entry.id}
              packName={entry.entry.name}
              packVersion={entry.entry.version}
              packDescription={entry.entry.description}
              packIcon={entry.entry.icon}
              characters={entry.entry.characters}
              pluginId={entry.pluginId}
            />
          ))}
          {isTauri() && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void handleImport()}>
                <UploadIcon className="mr-2 size-3.5" />
                {t("packs.importJsonAction")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void handleRescan()}>
                {t("packs.rescan")}
              </Button>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function PackRow({
  packId,
  packName,
  packVersion,
  packDescription,
  packIcon,
  characters,
  pluginId,
}: {
  packId: string
  packName: string
  packVersion: string
  packDescription?: string
  packIcon?: { emoji?: string; color?: string }
  characters: ReadonlyArray<import("@/types/plugin/plugin-character-pack").PluginCharacterDef>
  pluginId: string | undefined
}) {
  const t = useTranslations("settings.characters")
  const pluginMeta = usePluginMetadata(pluginId)
  const isLocal = pluginId === LOCAL_PACK_PLUGIN_ID || !pluginId
  const sourceText = isLocal
    ? t("packs.sourceLocal")
    : t("packs.sourcePlugin", { name: pluginMeta?.name ?? pluginId })
  const [expanded, setExpanded] = useState(false)
  // ADR-0030 §B.6 — surface pack-level warnings on the pack header chip
  // so the user knows at a glance that something inside this pack has a
  // missing dependency. Character-level detail is reached by expanding.
  const packWarnings = getPackWarnings(packId)

  const handleDelete = async () => {
    const result = await deleteLocalPack(packId)
    if (result.ok) {
      toast.success(t("packs.deletedToast", { id: packId }))
    } else {
      toast.error(result.error)
    }
  }

  const handleExport = async () => {
    try {
      const { exportPack } = await import("@/lib/plugin/character-pack/local-pack-store")
      const result = exportPack(packId)
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
        const blob = new Blob([result.value.body], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = result.value.filename
        a.click()
        URL.revokeObjectURL(url)
        toast.success(t("packs.exportedToastBrowser"))
      }
    } catch (err) {
      log.error("pack_export_failed", err, { packId })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-base"
          style={{
            backgroundColor: packIcon?.color ?? "oklch(0.7 0.1 250)",
            color: "white",
          }}
          aria-hidden
        >
          {packIcon?.emoji ?? "📦"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{packName}</p>
            <Badge variant="outline" className="font-mono text-[10px]">
              v{packVersion}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {sourceText}
            </Badge>
            {packWarnings.length > 0 && (
              <Badge
                variant="outline"
                className="border-yellow-500/40 bg-yellow-500/10 text-[10px] text-yellow-700 dark:text-yellow-300"
                title={packWarnings
                  .map((w) =>
                    w.characterLocalId
                      ? `${w.code} (${w.characterLocalId}): ${w.missingId}`
                      : `${w.code}: ${w.missingId}`
                  )
                  .join("\n")}
              >
                {t("badge.missingDep", { count: packWarnings.length })}
              </Badge>
            )}
          </div>
          {packDescription && (
            <p className="mt-0.5 text-xs text-muted-foreground">{packDescription}</p>
          )}
          <button
            type="button"
            className="mt-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-label={
              expanded
                ? t("packs.collapseAria", { id: packId })
                : t("packs.expandAria", { id: packId })
            }
          >
            {t("packs.characterCount", { count: characters.length })}
            <span aria-hidden> {expanded ? "▾" : "▸"}</span>
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
              {characters.map((ch) => (
                <li key={ch.localId} className="text-[11px]">
                  <span className="font-medium">{ch.name}</span>
                  {ch.description && (
                    <span className="text-muted-foreground"> — {ch.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void handleExport()}
            aria-label={t("exportPackAria", { name: packName })}
            title={t("actions.exportPack")}
          >
            <DownloadIcon className="size-3.5" />
          </Button>
          {isLocal && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:text-destructive"
                  aria-label={t("packs.deleteAria", { id: packId })}
                  title={t("packs.delete")}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("packs.removeTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("packs.removeBody", { id: packId })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleDelete()}>
                    {t("remove")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </Card>
  )
}

// --- Editor ---------------------------------------------------------------

export type EditorState = {
  name: string
  description: string
  avatarColor: string
  avatarEmoji: string
  systemPrompt: string
  model: string
  permissionMode: AppSettings["permissionMode"]
  allowedTools: string[]
  disallowedTools: string[]
  mcpServerIds: string[] | undefined
  skillIds: string[]
  workingDir: string
  bareMode: boolean
  debugMode: boolean
  briefMode: boolean
  twinId?: string
  twinSettings?: Character["twinSettings"]
  enableComputerUse: boolean
  computerUseSettings?: Character["computerUseSettings"]
  /** ADR-0020 remote-target — `"local"` or a sandbox connection id. */
  computerUseTarget: "local" | string
  /** ADR-0028 Phase 10 — per-character sandbox enablement override. */
  sandboxEnabled: boolean
  /** ADR-0028 Phase 10 — `"inherit"` writes back as `undefined`. */
  sandboxTier: "os" | "microvm" | "inherit"
  /** ADR-0028 Phase 10 — account UUID from `ProviderVault::accounts[]`. */
  accountIdOverride: string | "inherit"
  // ---- ADR-0030 v2 fields ---------------------------------------------------
  /** Persona — tone / personality prose. */
  personaTone: string
  personaPersonality: string
  /** Opening greeting seeded as the first assistant message on a new chat. */
  openingMessage: string
  /** Exemplar prompts (one per line) surfaced as quick-start chips. */
  exemplarPromptsText: string
  /** Avatar image as a web data URL ("" = none). */
  avatarImageDataUrl: string
  /** Voice profile — `"none"` means inherit the global TTS settings. */
  voiceProvider: TTSProvider | "none"
  voiceId: string
  voiceRate: number
  voicePitch: number
  voiceVolume: number
  /** Host profiles this character is available on (empty = all). */
  availablePlatforms: PluginRuntimeProfile[]
}

type EditorOutput = {
  name: string
  description?: string
  avatarColor: string
  avatarEmoji?: string
  systemPrompt: string
  model?: string
  permissionMode?: AppSettings["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  workingDir?: string
  bareMode?: boolean
  debugMode?: boolean
  briefMode?: boolean
  twinId?: string
  twinSettings?: Character["twinSettings"]
  enableComputerUse?: boolean
  computerUseSettings?: Character["computerUseSettings"]
  computerUseTarget?: Character["computerUseTarget"]
  sandboxEnabled?: boolean
  sandboxTier?: "os" | "microvm"
  accountIdOverride?: string
  // ---- ADR-0030 v2 fields ----
  persona?: PluginCharacterPersona
  voiceProfile?: PluginCharacterVoiceProfile
  avatarImage?: PluginCharacterAvatarImage
  availableOnPlatforms?: PluginRuntimeProfile[]
}

interface EditorProps {
  initial: EditorState
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  submitLabel: string
  onCancel: () => void
  onSave: (data: EditorOutput) => Promise<void>
  /** Id of the character being edited. Omitted when creating. */
  editingId?: string
}

interface AccountOption {
  accountId: string
  provider: string
  label: string
}

async function loadAccountOptions(): Promise<AccountOption[]> {
  const { listAccounts } = await import("@/lib/subscription/core/transport")
  const providers: Array<"anthropic" | "codex" | "opencode"> = ["anthropic", "codex", "opencode"]
  const all: AccountOption[] = []
  for (const provider of providers) {
    try {
      const list = await listAccounts(provider)
      for (const acc of list) {
        all.push({
          accountId: acc.id,
          provider,
          label: acc.label ?? acc.id.slice(0, 8),
        })
      }
    } catch {
      // Provider not configured or transport unavailable — skip.
    }
  }
  return all
}

export function CharacterEditor({
  initial,
  skillsCatalog,
  mcpCatalog,
  submitLabel,
  onCancel,
  onSave,
  editingId,
}: EditorProps) {
  const t = useTranslations("settings.characters")
  const tEditor = useTranslations("settings.characters.editor")
  const tGeneral = useTranslations("settings.general")
  const tSandbox = useTranslations("settings.characters.editor.sandbox")
  const tAccount = useTranslations("settings.characters.editor.account")
  const [s, setS] = useState<EditorState>(initial)
  const [allowToolsText, setAllowToolsText] = useState(initial.allowedTools.join(", "))
  const [denyToolsText, setDenyToolsText] = useState(initial.disallowedTools.join(", "))
  const [saving, setSaving] = useState(false)
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([])

  useEffect(() => {
    let cancelled = false
    void loadAccountOptions().then((opts) => {
      if (!cancelled) setAccountOptions(opts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Hydrate when `initial` changes (e.g. user clicks edit on a different row).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setS(initial)
    setAllowToolsText(initial.allowedTools.join(", "))
    setDenyToolsText(initial.disallowedTools.join(", "))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initial])

  // Voice catalog for the currently-selected provider (undefined for
  // `system` / no provider — those fall back to a free-text voice id).
  const voiceCatalog = s.voiceProvider !== "none" ? VOICE_CATALOG[s.voiceProvider] : undefined

  // Read a picked image file into a `data:` URL stored on the character.
  // Warns (non-blocking, mirrors `defineCharacterPack`) when the encoded
  // payload exceeds 64 KB — keeps the Dexie row small.
  const handleAvatarFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-selecting the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      if (!result) return
      if (result.length > 64 * 1024) {
        toast.warning(tEditor("avatarImage.large"))
      }
      setS((prev) => ({ ...prev, avatarImageDataUrl: result }))
    }
    reader.readAsDataURL(file)
  }

  const submit = async () => {
    if (!s.name.trim()) {
      toast.error(t("validation.nameRequired"))
      return
    }
    if (!s.systemPrompt.trim()) {
      toast.error(t("validation.systemPromptRequired"))
      return
    }
    setSaving(true)
    try {
      const allowed = parseChips(allowToolsText)
      const disallowed = parseChips(denyToolsText)
      await onSave({
        name: s.name.trim(),
        description: s.description.trim() || undefined,
        avatarColor: s.avatarColor,
        avatarEmoji: s.avatarEmoji.trim() || undefined,
        systemPrompt: s.systemPrompt,
        model: s.model.trim() || undefined,
        permissionMode: s.permissionMode,
        allowedTools: allowed.length > 0 ? allowed : undefined,
        disallowedTools: disallowed.length > 0 ? disallowed : undefined,
        mcpServerIds: s.mcpServerIds,
        skillIds: s.skillIds.length > 0 ? s.skillIds : undefined,
        workingDir: s.workingDir.trim() || undefined,
        bareMode: s.bareMode || undefined,
        debugMode: s.debugMode || undefined,
        briefMode: s.briefMode || undefined,
        twinId: s.twinId,
        twinSettings: s.twinSettings,
        enableComputerUse: s.enableComputerUse || undefined,
        computerUseSettings: s.computerUseSettings,
        computerUseTarget:
          s.enableComputerUse && s.computerUseTarget && s.computerUseTarget !== "local"
            ? { connectionId: s.computerUseTarget }
            : undefined,
        sandboxEnabled: s.sandboxEnabled || undefined,
        sandboxTier: s.sandboxTier === "inherit" ? undefined : s.sandboxTier,
        accountIdOverride: s.accountIdOverride === "inherit" ? undefined : s.accountIdOverride,
        persona: buildPersona({
          tone: s.personaTone,
          personality: s.personaPersonality,
          openingMessage: s.openingMessage,
          exemplarPromptsText: s.exemplarPromptsText,
        }),
        voiceProfile: buildVoiceProfile({
          provider: s.voiceProvider,
          voiceId: s.voiceId,
          rate: s.voiceRate,
          pitch: s.voicePitch,
          volume: s.voiceVolume,
        }),
        avatarImage: s.avatarImageDataUrl ? { webDataUrl: s.avatarImageDataUrl } : undefined,
        availableOnPlatforms: s.availablePlatforms.length > 0 ? s.availablePlatforms : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <div className="flex flex-col items-center gap-2">
          <AvatarBadge
            subject={{
              name: s.name,
              avatarColor: s.avatarColor || COLOR_PALETTE[0],
              avatarEmoji: s.avatarEmoji,
              avatarImageUrl: s.avatarImageDataUrl || undefined,
            }}
            size={48}
            textClassName="text-lg"
          />
          <Input
            value={s.avatarEmoji}
            onChange={(e) => setS({ ...s, avatarEmoji: e.target.value })}
            placeholder={tEditor("avatarEmojiPlaceholder")}
            className="h-7 w-12 text-center"
            maxLength={4}
            aria-label={tEditor("avatarEmoji")}
          />
          <div className="grid grid-cols-4 gap-1">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setS({ ...s, avatarColor: c })}
                className="size-4 rounded-full ring-1 ring-border"
                style={{
                  backgroundColor: c,
                  outline: s.avatarColor === c ? "2px solid var(--ring)" : undefined,
                  outlineOffset: 2,
                }}
                aria-label={tEditor("pickColor", { color: c })}
              />
            ))}
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <label className="cursor-pointer text-[10px] text-primary underline-offset-2 hover:underline">
              {tEditor("avatarImage.upload")}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarFile}
                aria-label={tEditor("avatarImage.upload")}
              />
            </label>
            {s.avatarImageDataUrl && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setS({ ...s, avatarImageDataUrl: "" })}
              >
                {tEditor("avatarImage.clear")}
              </button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("name")}</Label>
            <Input
              value={s.name}
              onChange={(e) => setS({ ...s, name: e.target.value })}
              placeholder={tEditor("namePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("description")}</Label>
            <Input
              value={s.description}
              onChange={(e) => setS({ ...s, description: e.target.value })}
              placeholder={tEditor("descriptionPlaceholder")}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("systemPrompt")}</Label>
        <Textarea
          rows={6}
          value={s.systemPrompt}
          onChange={(e) => setS({ ...s, systemPrompt: e.target.value })}
          className="text-sm"
          placeholder={tEditor("systemPromptPlaceholder")}
        />
      </div>

      {/* ADR-0030 v2 — persona (tone / personality / opening / exemplars) */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <Label className="text-xs font-medium">{tEditor("persona.title")}</Label>
        <p className="text-[10px] text-muted-foreground">{tEditor("persona.description")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("persona.tone")}</Label>
            <Input
              value={s.personaTone}
              onChange={(e) => setS({ ...s, personaTone: e.target.value })}
              placeholder={tEditor("persona.tonePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("persona.personality")}</Label>
            <Input
              value={s.personaPersonality}
              onChange={(e) => setS({ ...s, personaPersonality: e.target.value })}
              placeholder={tEditor("persona.personalityPlaceholder")}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("persona.openingMessage")}</Label>
          <Textarea
            rows={2}
            value={s.openingMessage}
            onChange={(e) => setS({ ...s, openingMessage: e.target.value })}
            className="text-sm"
            placeholder={tEditor("persona.openingMessagePlaceholder")}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("persona.exemplarPrompts")}</Label>
          <Textarea
            rows={3}
            value={s.exemplarPromptsText}
            onChange={(e) => setS({ ...s, exemplarPromptsText: e.target.value })}
            className="text-sm"
            placeholder={tEditor("persona.exemplarPromptsPlaceholder")}
          />
          <p className="text-[10px] text-muted-foreground">
            {tEditor("persona.exemplarPromptsHint")}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("model")}</Label>
          <Select
            value={s.model || "__default__"}
            onValueChange={(v) => setS({ ...s, model: v === "__default__" ? "" : v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{tEditor("useDefault")}</SelectItem>
              {MODEL_PRESET_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {tGeneral(`model.${v}` as `model.${typeof v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={s.model}
            onChange={(e) => setS({ ...s, model: e.target.value })}
            placeholder={tEditor("modelIdPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("permissionMode")}</Label>
          <Select
            value={s.permissionMode ?? "__default__"}
            onValueChange={(v) =>
              setS({
                ...s,
                permissionMode:
                  v === "__default__" ? undefined : (v as AppSettings["permissionMode"]),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{tEditor("useDefault")}</SelectItem>
              {PERMISSION_MODE_VALUES.map((m) => (
                <SelectItem key={m} value={m}>
                  {tGeneral(`permission.${m}` as `permission.${typeof m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("allowedTools")}</Label>
          <Input
            value={allowToolsText}
            onChange={(e) => setAllowToolsText(e.target.value)}
            placeholder={tEditor("allowedToolsPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("disallowedTools")}</Label>
          <Input
            value={denyToolsText}
            onChange={(e) => setDenyToolsText(e.target.value)}
            placeholder={tEditor("disallowedToolsPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("workingDir")}</Label>
        <Input
          value={s.workingDir}
          onChange={(e) => setS({ ...s, workingDir: e.target.value })}
          placeholder={tEditor("workingDirPlaceholder")}
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="cursor-pointer text-xs">{tGeneral("bareMode")}</Label>
          <Switch
            checked={s.bareMode}
            onCheckedChange={(v) => setS({ ...s, bareMode: v })}
            aria-label={tGeneral("bareMode")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="cursor-pointer text-xs">{tGeneral("debugMode")}</Label>
          <Switch
            checked={s.debugMode}
            onCheckedChange={(v) => setS({ ...s, debugMode: v })}
            aria-label={tGeneral("debugMode")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="cursor-pointer text-xs">{tGeneral("briefMode")}</Label>
          <Switch
            checked={s.briefMode}
            onCheckedChange={(v) => setS({ ...s, briefMode: v })}
            aria-label={tGeneral("briefMode")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="cursor-pointer text-xs">{t("computerUseToggle.label")}</Label>
            <p className="text-[10px] text-muted-foreground">
              {t("computerUseToggle.description")}
            </p>
          </div>
          <Switch
            checked={s.enableComputerUse}
            onCheckedChange={(v) => setS({ ...s, enableComputerUse: v })}
            aria-label={t("computerUseToggle.aria")}
          />
        </div>
        {s.enableComputerUse && (
          <>
            <ComputerUseSubSettings
              value={s.computerUseSettings}
              onChange={(next) => setS({ ...s, computerUseSettings: next })}
            />
            <ComputerUseTargetPicker
              value={s.computerUseTarget}
              onChange={(target) => setS({ ...s, computerUseTarget: target })}
            />
          </>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="cursor-pointer text-xs">{tSandbox("enable.label")}</Label>
            <p className="text-[10px] text-muted-foreground">{tSandbox("enable.description")}</p>
          </div>
          <Switch
            checked={s.sandboxEnabled}
            onCheckedChange={(v) => setS({ ...s, sandboxEnabled: v })}
            aria-label={tSandbox("enable.aria")}
            data-testid="character-sandbox-enabled"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tSandbox("tier.label")}</Label>
          <Select
            value={s.sandboxTier}
            onValueChange={(value) =>
              setS({
                ...s,
                sandboxTier: value as EditorState["sandboxTier"],
              })
            }
          >
            <SelectTrigger data-testid="character-sandbox-tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tSandbox("tier.inherit")}</SelectItem>
              <SelectItem value="os">{tSandbox("tier.os")}</SelectItem>
              <SelectItem value="microvm">{tSandbox("tier.microvm")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">{tSandbox("tier.description")}</p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tAccount("label")}</Label>
          <Select
            value={s.accountIdOverride}
            onValueChange={(value) =>
              setS({
                ...s,
                accountIdOverride: value as EditorState["accountIdOverride"],
              })
            }
          >
            <SelectTrigger data-testid="character-account-override">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tAccount("inherit")}</SelectItem>
              {accountOptions.map((opt) => (
                <SelectItem key={opt.accountId} value={opt.accountId}>
                  {tAccount("optionLabel", {
                    provider: opt.provider,
                    label: opt.label,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">{tAccount("description")}</p>
        </div>
      </div>

      <TwinBindingSection
        value={{ twinId: s.twinId, twinSettings: s.twinSettings }}
        onChange={(next: TwinBindingValue) =>
          setS({ ...s, twinId: next.twinId, twinSettings: next.twinSettings })
        }
        excludeCharacterId={editingId}
      />

      <ItemMultiSelect
        label={tEditor("skills")}
        helpText={tEditor("skillsHint")}
        items={skillsCatalog.map((sk) => ({
          id: sk.id,
          name: sk.name,
          description: sk.description,
        }))}
        selectedIds={s.skillIds}
        onChange={(ids) => setS({ ...s, skillIds: ids })}
      />

      <ItemMultiSelect
        label={tEditor("mcpServers")}
        helpText={tEditor("mcpServersHint")}
        items={mcpCatalog.map((m) => ({
          id: m.id,
          name: m.name,
          description: `${m.transport}${m.enabled ? "" : " — disabled"}`,
        }))}
        selectedIds={s.mcpServerIds ?? []}
        allowEmpty
        emptyHint={tEditor("mcpServersEmptyHint")}
        onChange={(ids) => setS({ ...s, mcpServerIds: ids.length > 0 ? ids : undefined })}
      />

      {/* ADR-0030 v2 — voice profile (rides the existing TTS subsystem) */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <Label className="text-xs font-medium">{tEditor("voice.title")}</Label>
        <p className="text-[10px] text-muted-foreground">{tEditor("voice.description")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("voice.provider")}</Label>
            <Select
              value={s.voiceProvider}
              onValueChange={(v) =>
                setS({ ...s, voiceProvider: v as EditorState["voiceProvider"], voiceId: "" })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tEditor("voice.inherit")}</SelectItem>
                {Object.values(TTS_PROVIDERS).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {s.voiceProvider !== "none" && (
            <div className="space-y-1">
              <Label className="text-xs">{tEditor("voice.voiceId")}</Label>
              {voiceCatalog ? (
                <Select value={s.voiceId} onValueChange={(v) => setS({ ...s, voiceId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={tEditor("voice.voiceIdPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {voiceCatalog.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={s.voiceId}
                  onChange={(e) => setS({ ...s, voiceId: e.target.value })}
                  placeholder={tEditor("voice.voiceIdPlaceholder")}
                  className="font-mono text-xs"
                />
              )}
            </div>
          )}
        </div>
        {s.voiceProvider !== "none" && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <VoiceSlider
                label={tEditor("voice.rate")}
                value={s.voiceRate}
                min={0.5}
                max={2}
                onChange={(n) => setS({ ...s, voiceRate: n })}
              />
              <VoiceSlider
                label={tEditor("voice.pitch")}
                value={s.voicePitch}
                min={0.5}
                max={2}
                onChange={(n) => setS({ ...s, voicePitch: n })}
              />
              <VoiceSlider
                label={tEditor("voice.volume")}
                value={s.voiceVolume}
                min={0}
                max={1}
                onChange={(n) => setS({ ...s, voiceVolume: n })}
              />
            </div>
            <TestTtsButton
              voiceOverlay={resolveCharacterVoice({
                voiceProfile: buildVoiceProfile({
                  provider: s.voiceProvider,
                  voiceId: s.voiceId,
                  rate: s.voiceRate,
                  pitch: s.voicePitch,
                  volume: s.voiceVolume,
                }),
              })}
              sampleText={s.openingMessage.trim() || undefined}
            />
          </div>
        )}
      </div>

      {/* ADR-0030 v2 — platform availability (empty = all) */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <Label className="text-xs font-medium">{tEditor("platforms.title")}</Label>
        <p className="text-[10px] text-muted-foreground">{tEditor("platforms.description")}</p>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORM_OPTIONS.map((p) => {
            const active = s.availablePlatforms.includes(p)
            return (
              <Badge
                key={p}
                variant={active ? "default" : "outline"}
                className="cursor-pointer text-xs hover:bg-primary/10"
                onClick={() =>
                  setS({
                    ...s,
                    availablePlatforms: active
                      ? s.availablePlatforms.filter((x) => x !== p)
                      : [...s.availablePlatforms, p],
                  })
                }
              >
                {tEditor(`platforms.${p}` as `platforms.${PluginRuntimeProfile}`)}
              </Badge>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? t("saving") : submitLabel}
        </Button>
      </div>
    </Card>
  )
}

// ADR-0020 W2 — per-character Computer Use sub-settings.
//
// Only rendered when `enableComputerUse === true`. Surfaces three knobs
// that were declared in v40 but had no UI consumer pre-W2:
//
//  - `requireConsent` — forces every driving call into the Rust
//    `PerCall` consent path for this character, regardless of the
//    global `automationSettings.perSurface.computerUse.tier`.
//    `applyComputerUseTools` stamps `forceTier: "perCall"` on each
//    Anthropic tool def when this is set.
//  - `chatConsentMode` — drives Wave 3's chat-side dedup logic. `auto`
//    suppresses the chat modal when the Rust gate is PerCall;
//    `session-grant` remembers the operator's first decision for the
//    session; `always-ask` keeps both gates prompting independently.
//  - `allowedToolIds` — narrows which registered native tools the
//    character actually exposes. Empty set = "all", matching the
//    fast-path in `applyComputerUseTools`.
interface ComputerUseSubSettingsProps {
  value: Character["computerUseSettings"]
  onChange: (next: Character["computerUseSettings"]) => void
}

function ComputerUseSubSettings({ value, onChange }: ComputerUseSubSettingsProps) {
  const t = useTranslations("settings.characters.editor.computerUseSubSettings")
  const v = value ?? {}
  const requireConsent = Boolean(v.requireConsent)
  const consentMode = v.chatConsentMode ?? "always-ask"
  const allowed = v.allowedToolIds ?? []

  // Read the live registry once on mount. The registry doesn't change
  // at runtime within a single render pass, so a useState seed is fine
  // — re-mounting the editor (e.g. switching characters) picks up any
  // newly-enabled tool plugin.
  const [registeredTools] = useState(() =>
    listNativeAnthropicToolEntries().map((row) => ({
      id: row.id,
      name: row.entry.name,
    }))
  )

  function update(patch: Partial<NonNullable<Character["computerUseSettings"]>>): void {
    onChange({ ...v, ...patch })
  }

  function toggleTool(id: string, on: boolean): void {
    const next = new Set(allowed)
    if (on) next.add(id)
    else next.delete(id)
    // Treat "empty set" as "all" by storing `undefined` rather than
    // `[]` — the runtime fast-path in `applyComputerUseTools` reads
    // `undefined` as "no filter" and we keep the stored shape minimal.
    update({ allowedToolIds: next.size === 0 ? undefined : Array.from(next) })
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3 pl-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="cursor-pointer text-xs">{t("requireConsent.label")}</Label>
          <p className="text-[10px] text-muted-foreground">{t("requireConsent.description")}</p>
        </div>
        <Switch
          checked={requireConsent}
          onCheckedChange={(b) => update({ requireConsent: b })}
          aria-label={t("requireConsent.label")}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="cursor-pointer text-xs">{t("screenOffMode.label")}</Label>
          <p className="text-[10px] text-muted-foreground">{t("screenOffMode.description")}</p>
        </div>
        <Switch
          checked={Boolean(v.screenOffMode)}
          onCheckedChange={(b) => update({ screenOffMode: b })}
          aria-label={t("screenOffMode.label")}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("chatConsentMode.label")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("chatConsentMode.description")}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {(["always-ask", "session-grant", "auto"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={consentMode === mode ? "default" : "outline"}
              onClick={() => update({ chatConsentMode: mode })}
            >
              {t(`chatConsentMode.options.${mode}`)}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("allowedToolIds.label")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("allowedToolIds.description")}</p>
        {registeredTools.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">{t("allowedToolIds.empty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            {registeredTools.map((tool) => {
              const checked = allowed.length === 0 || allowed.includes(tool.id)
              return (
                <label
                  key={tool.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px]"
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={checked}
                    onChange={(e) => toggleTool(tool.id, e.target.checked)}
                    aria-label={tool.name}
                  />
                  <code className="font-mono">{tool.name}</code>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ADR-0020 remote-target — per-character Computer Use execution target.
// "local" runs GUI actions on this host; selecting a configured cua sandbox
// routes them into that isolated Docker desktop instead. Connections are
// managed in Settings → Automation → Sandboxes.
interface ComputerUseTargetPickerProps {
  value: "local" | string
  onChange: (next: "local" | string) => void
}

function ComputerUseTargetPicker({ value, onChange }: ComputerUseTargetPickerProps) {
  const t = useTranslations("settings.characters.editor.computerUseTarget")
  const { connections } = useSandboxConnections()
  return (
    <div className="space-y-1">
      <Label className="text-xs">{t("label")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={t("label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{t("local")}</SelectItem>
          {connections.map((conn) => (
            <SelectItem key={conn.id} value={conn.id}>
              {conn.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">{t("description")}</p>
    </div>
  )
}

function parseChips(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

interface MultiSelectProps {
  label: string
  helpText?: string
  items: Array<{ id: string; name: string; description?: string }>
  selectedIds: string[]
  onChange: (ids: string[]) => void
  allowEmpty?: boolean
  emptyHint?: string
}

/**
 * Compact multi-select with optional ordering: clicking adds to the end of
 * the selection (preserving order); clicking again removes.
 */
function ItemMultiSelect({
  label,
  helpText,
  items,
  selectedIds,
  onChange,
  allowEmpty,
  emptyHint,
}: MultiSelectProps) {
  const tMS = useTranslations("settings.characters.multiselect")
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  const move = (id: string, dir: -1 | 1) => {
    const idx = selectedIds.indexOf(id)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= selectedIds.length) return
    const next = [...selectedIds]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {helpText && <p className="text-[11px] text-muted-foreground">{helpText}</p>}
      {selectedIds.length === 0 && allowEmpty && emptyHint && (
        <p className="text-[11px] italic text-muted-foreground">{emptyHint}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 ? (
          <p className="text-[11px] italic text-muted-foreground">{tMS("noneDefined")}</p>
        ) : (
          items.map((it) => {
            const active = selectedIds.includes(it.id)
            const order = active ? selectedIds.indexOf(it.id) + 1 : null
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => toggle(it.id)}
                className={
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors " +
                  (active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted")
                }
                title={it.description}
              >
                {order !== null && (
                  <span className="font-mono text-[10px] text-muted-foreground">#{order}</span>
                )}
                {it.name}
              </button>
            )
          })
        )}
      </div>
      {selectedIds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] text-muted-foreground">{tMS("reorder")}</span>
          {selectedIds.map((id) => {
            const it = items.find((x) => x.id === id)
            if (!it) return null
            return (
              <span
                key={id}
                className="inline-flex items-center gap-0.5 rounded border bg-background px-1 text-[11px]"
              >
                {it.name}
                <button
                  type="button"
                  onClick={() => move(id, -1)}
                  className="px-1 text-muted-foreground hover:text-foreground"
                  aria-label={tMS("moveUp", { name: it.name })}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(id, 1)}
                  className="px-1 text-muted-foreground hover:text-foreground"
                  aria-label={tMS("moveDown", { name: it.name })}
                >
                  ↓
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
