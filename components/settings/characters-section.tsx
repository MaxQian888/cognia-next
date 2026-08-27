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
import {
  createKnowledgeBase,
  getKnowledgeBaseReferences,
  listKnowledgeBases,
} from "@/lib/db/knowledge-bases"
import type { KnowledgeBase, KnowledgeBaseReference } from "@/types/knowledge-base"
import type {
  AgentEnvBinding,
  AppSettings,
  Character,
  McpServer,
  Skill,
} from "@cognia/agent-config-types"
// ADR-0020 W2 — Computer Use sub-settings UI reads the live native-tool
// registry so allowedToolIds is a real picker (one checkbox per
// registered tool) instead of a free-form text field. `listEntries`
// returns the same shape `applyComputerUseTools` filters against.
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
// ADR-0030 — Character pack overlay + local-imported pack file support.
import {
  getCharacterPackRegistryVersion,
  getPackCharacterWarnings,
  getPackTrust,
  getPackWarnings,
  isOverlayCharacterId,
  listCharacterPackEntries,
  subscribeCharacterPackRegistry,
} from "@/lib/plugin/registries/character-pack-registry"
import type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"
import {
  formatPackWarnings,
  PackTrustChip,
} from "@/components/settings/character/pack-trust-badges"
import {
  deleteLocalPack,
  importLocalPack,
  LOCAL_PACK_PLUGIN_ID,
} from "@/lib/plugin/character-pack/local-pack-store"
import { usePluginMetadata } from "@/hooks/plugins/use-plugin-metadata"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import type { SandboxShellTier } from "@/types/sandbox"
import { isTauri } from "@/lib/tauri"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { TestTtsButton } from "@/components/settings/speech/test-tts-button"
import { KnowledgeBaseManager } from "@/components/settings/knowledge-base-manager"
import { AgentTaskBoardDialog } from "@/components/agent/agent-task-board"
import { SupportDiagnosticsConsent } from "@/components/support/support-diagnostics-consent"
import { removeKnowledgeBase } from "@/lib/knowledge-base/ingest/ingest-source"
import { isSupportAgentId } from "@/lib/support-agent/context"
import { tryBuildProjectKnowledgeDeps } from "@/lib/project-knowledge/runtime/build-deps"
import { resolveCharacterVoice } from "@/lib/plugin/character-pack/character-voice"
import { buildPersona, buildVoiceProfile } from "@/lib/plugin/character-pack/editor-projection"
import type {
  PluginCharacterAvatarImage,
  PluginCharacterPersona,
  PluginCharacterVoiceProfile,
} from "@/types/plugin/plugin-character-pack"
import type { PluginRuntimeProfile } from "@/types/plugin/plugin"
import {
  ORDERED_TTS_PROVIDERS,
  TTS_PROVIDER_SETTINGS,
  TTS_PROVIDERS,
  type SelectableTTSProvider,
} from "@cognia/tts/types"
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
  LibraryBigIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Checkbox } from "@/components/ui/checkbox"
import { characterToPackDef, filterCharacters } from "@/lib/plugin/character-pack/editor-projection"
import { serializeLocalPackFile } from "@/lib/plugin/character-pack/schema"
import { downloadBlob } from "@/lib/files/download"
import { createLogger } from "@cognia/logging"
import { modelPresetOptions, PERMISSION_MODE_VALUES } from "@/lib/claude/model-presets"
import { useUIStore } from "@/stores/ui/ui-store"
import { isValidAgentEnvName } from "@/lib/agent/agent-profile-policy"
import { createAgentEnvSecretRef, saveAgentEnvSecret } from "@/lib/agent/agent-env-keyring"

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
const VOICE_CATALOG: Partial<
  Record<SelectableTTSProvider, ReadonlyArray<{ id: string; name: string }>>
> = Object.fromEntries(
  ORDERED_TTS_PROVIDERS.flatMap((provider) => {
    const voices = TTS_PROVIDER_SETTINGS[provider].voices
    return voices ? [[provider, voices]] : []
  })
)

const PLATFORM_OPTIONS: PluginRuntimeProfile[] = ["tauri", "browser", "mobile"]

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
  const knowledgeBases = useLiveQuery(() => listKnowledgeBases(), []) ?? []
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

      <KnowledgeBaseSubsection knowledgeBases={knowledgeBases} />

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
              knowledgeBaseCatalog={knowledgeBases}
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
            planModel: "",
            utilityModel: "",
            executionEffort: "inherit",
            executionMaxTurns: "",
            executionEnvBindings: undefined,
            permissionMode: undefined,
            allowedTools: [],
            disallowedTools: [],
            mcpServerIds: undefined,
            skillIds: [],
            knowledgeBaseIds: [],
            memoryRecall: true,
            memoryCreate: true,
            memoryUpdate: true,
            memoryForget: true,
            memoryAutoLearn: true,
            memoryReadableScopes: ["global", "workspace", "character", "agent"],
            memoryWritableScopes: ["global", "workspace", "character", "agent"],
            workingDir: "",
            bareMode: false,
            debugMode: false,
            briefMode: false,
            twinId: undefined,
            twinSettings: undefined,
            enableComputerUse: false,
            enableBrowserTools: false,
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
          knowledgeBaseCatalog={knowledgeBases}
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

function KnowledgeBaseSubsection({ knowledgeBases }: { knowledgeBases: KnowledgeBase[] }) {
  const t = useTranslations("settings.characters.knowledgeBases")
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{
    knowledgeBase: KnowledgeBase
    references: KnowledgeBaseReference[]
  } | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      await createKnowledgeBase({ name: trimmed })
      setName("")
      toast.success(t("created", { name: trimmed }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const inspectDelete = async (knowledgeBase: KnowledgeBase) => {
    try {
      const references = await getKnowledgeBaseReferences(knowledgeBase.id)
      setPendingDelete({ knowledgeBase, references })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      const deps = await tryBuildProjectKnowledgeDeps()
      await removeKnowledgeBase(pendingDelete.knowledgeBase.id, {
        detachReferences: pendingDelete.references.length > 0,
        deps,
      })
      toast.success(t("deleted", { name: pendingDelete.knowledgeBase.name }))
      setPendingDelete(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start gap-2">
        <LibraryBigIcon className="mt-0.5 size-4" />
        <div>
          <Label className="text-xs font-medium">{t("title")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("description")}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create()
          }}
          placeholder={t("namePlaceholder")}
          aria-label={t("name")}
        />
        <Button
          type="button"
          variant="outline"
          disabled={creating || !name.trim()}
          onClick={() => void create()}
        >
          <PlusIcon className="mr-1 size-3.5" />
          {t("create")}
        </Button>
      </div>
      {knowledgeBases.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {knowledgeBases.map((knowledgeBase) => (
            <div
              key={knowledgeBase.id}
              className="flex items-center justify-between rounded-md border px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{knowledgeBase.name}</p>
                {knowledgeBase.description && (
                  <p className="truncate text-[10px] text-muted-foreground">
                    {knowledgeBase.description}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                onClick={() => void inspectDelete(knowledgeBase)}
                aria-label={t("deleteAria", { name: knowledgeBase.name })}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <KnowledgeBaseManager knowledgeBases={knowledgeBases} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.references.length
                ? t("deleteReferenced", { count: pendingDelete.references.length })
                : t("deleteUnreferenced")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(pendingDelete?.references.length ?? 0) > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {pendingDelete?.references.map((reference) => (
                <li key={`${reference.kind}:${reference.id}`}>{reference.name}</li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {pendingDelete?.references.length ? t("detachAndDelete") : t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

interface RowProps {
  character: Character
  skills: Skill[]
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  knowledgeBaseCatalog: KnowledgeBase[]
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
  knowledgeBaseCatalog,
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
          model: character.modelRouting?.execute ?? character.model ?? "",
          planModel: character.modelRouting?.plan ?? "",
          utilityModel: character.modelRouting?.utility ?? "",
          executionEffort: character.executionPolicy?.effort ?? "inherit",
          executionMaxTurns: character.executionPolicy?.maxTurns?.toString() ?? "",
          executionEnvBindings: character.executionPolicy?.envBindings,
          permissionMode: character.permissionMode,
          allowedTools: character.allowedTools ?? [],
          disallowedTools: character.disallowedTools ?? [],
          mcpServerIds: character.mcpServerIds,
          skillIds: character.skillIds ?? [],
          knowledgeBaseIds: character.knowledgeBaseIds ?? [],
          memoryRecall: character.memoryPolicy?.operations.recall ?? true,
          memoryCreate: character.memoryPolicy?.operations.create ?? true,
          memoryUpdate: character.memoryPolicy?.operations.update ?? true,
          memoryForget: character.memoryPolicy?.operations.forget ?? true,
          memoryAutoLearn: character.memoryPolicy?.autoLearn ?? true,
          memoryReadableScopes: character.memoryPolicy?.readableScopes ?? [
            "global",
            "workspace",
            "character",
            "agent",
          ],
          memoryWritableScopes: character.memoryPolicy?.writableScopes ?? [
            "global",
            "workspace",
            "character",
            "agent",
          ],
          workingDir: character.workingDir ?? "",
          bareMode: Boolean(character.bareMode),
          debugMode: Boolean(character.debugMode),
          briefMode: Boolean(character.briefMode),
          twinId: character.twinId,
          twinSettings: character.twinSettings,
          enableComputerUse: Boolean(character.enableComputerUse),
          enableBrowserTools: Boolean(character.enableBrowserTools),
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
        knowledgeBaseCatalog={knowledgeBaseCatalog}
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
  const warningTitle = formatPackWarnings(warnings, t)

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
          {isSupportAgentId(character.id) && (
            <SupportDiagnosticsConsent surface="settings" className="mt-2" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <AgentTaskBoardDialog agentId={character.id} agentName={character.name} />
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
  // Local imports/deletes and dependency-warning refreshes mutate this
  // in-memory registry without changing the plugin Zustand store. Subscribe to
  // the registry itself so every mutation reaches the Settings UI immediately.
  // The numeric snapshot is stable between mutations; using the entries array
  // as a snapshot would allocate on every render and make React loop forever.
  useSyncExternalStore(
    subscribeCharacterPackRegistry,
    getCharacterPackRegistryVersion,
    getCharacterPackRegistryVersion
  )
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
  // ADR-0030 — signature trust, which is a different question from the
  // dependency warnings above: it attests to who authored the pack, not to
  // what happens to be installed here. Plugin-contributed packs suppress the
  // "unsigned" chip; see `PackTrustChipProps.showUnsigned`.
  const packTrust = getPackTrust(packId)

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
            <PackTrustChip trust={packTrust} showUnsigned={isLocal} />
            {packWarnings.length > 0 && (
              <Badge
                variant="outline"
                className="border-yellow-500/40 bg-yellow-500/10 text-[10px] text-yellow-700 dark:text-yellow-300"
                title={formatPackWarnings(packWarnings, t)}
              >
                {t("badge.missingDep", { count: packWarnings.length })}
              </Badge>
            )}
          </div>
          {packDescription && (
            <p className="mt-0.5 text-xs text-muted-foreground">{packDescription}</p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-auto justify-start p-0 text-left text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-label={
              expanded
                ? t("packs.collapseAria", { id: packId })
                : t("packs.expandAria", { id: packId })
            }
          >
            {t("packs.characterCount", { count: characters.length })}
            <span aria-hidden> {expanded ? "▾" : "▸"}</span>
          </Button>
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
  planModel: string
  utilityModel: string
  executionEffort: NonNullable<Character["executionPolicy"]>["effort"] | "inherit"
  executionMaxTurns: string
  executionEnvBindings: NonNullable<Character["executionPolicy"]>["envBindings"]
  permissionMode: AppSettings["permissionMode"]
  allowedTools: string[]
  disallowedTools: string[]
  mcpServerIds: string[] | undefined
  skillIds: string[]
  knowledgeBaseIds: string[]
  memoryRecall: boolean
  memoryCreate: boolean
  memoryUpdate: boolean
  memoryForget: boolean
  memoryAutoLearn: boolean
  memoryReadableScopes: NonNullable<Character["memoryPolicy"]>["readableScopes"]
  memoryWritableScopes: NonNullable<Character["memoryPolicy"]>["writableScopes"]
  workingDir: string
  bareMode: boolean
  debugMode: boolean
  briefMode: boolean
  twinId?: string
  twinSettings?: Character["twinSettings"]
  enableComputerUse: boolean
  enableBrowserTools: boolean
  computerUseSettings?: Character["computerUseSettings"]
  /** ADR-0020 remote-target — `"local"` or a sandbox connection id. */
  computerUseTarget: "local" | string
  /** ADR-0028 Phase 10 — per-character sandbox enablement override. */
  sandboxEnabled: boolean
  /** ADR-0028 Phase 10 — `"inherit"` writes back as `undefined`. */
  sandboxTier: SandboxShellTier | "inherit"
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

type AgentMemoryScope = EditorState["memoryReadableScopes"][number]
type MemoryBooleanField =
  "memoryRecall" | "memoryCreate" | "memoryUpdate" | "memoryForget" | "memoryAutoLearn"

const AGENT_MEMORY_SCOPES: readonly AgentMemoryScope[] = [
  "global",
  "workspace",
  "character",
  "agent",
]

function MemoryPolicyEditor({
  state,
  onChange,
}: {
  state: EditorState
  onChange: (next: EditorState) => void
}) {
  const t = useTranslations("settings.characters.editor.memoryPolicy")
  const operationRows: Array<{ field: MemoryBooleanField; label: string }> = [
    { field: "memoryRecall", label: t("operations.recall") },
    { field: "memoryCreate", label: t("operations.create") },
    { field: "memoryUpdate", label: t("operations.update") },
    { field: "memoryForget", label: t("operations.forget") },
    { field: "memoryAutoLearn", label: t("operations.autoLearn") },
  ]

  const toggleScope = (
    field: "memoryReadableScopes" | "memoryWritableScopes",
    scope: AgentMemoryScope
  ) => {
    const selected = state[field]
    onChange({
      ...state,
      [field]: selected.includes(scope)
        ? selected.filter((candidate) => candidate !== scope)
        : [...selected, scope],
    })
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="space-y-1">
        <Label className="text-xs font-medium">{t("title")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
        <p className="text-[10px] text-muted-foreground">{t("globalCeiling")}</p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {operationRows.map(({ field, label }) => (
          <div key={field} className="flex items-center justify-between gap-3 rounded border p-2">
            <Label className="cursor-pointer text-xs" htmlFor={`character-${field}`}>
              {label}
            </Label>
            <Switch
              id={`character-${field}`}
              checked={state[field]}
              onCheckedChange={(checked) => onChange({ ...state, [field]: checked })}
              aria-label={label}
            />
          </div>
        ))}
      </div>

      {(
        [
          ["memoryReadableScopes", t("readableScopes")],
          ["memoryWritableScopes", t("writableScopes")],
        ] as const
      ).map(([field, label]) => (
        <fieldset key={field} className="space-y-2">
          <legend className="text-xs font-medium">{label}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {AGENT_MEMORY_SCOPES.map((scope) => {
              const id = `character-${field}-${scope}`
              return (
                <div key={scope} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={state[field].includes(scope)}
                    onCheckedChange={() => toggleScope(field, scope)}
                    aria-label={`${label}: ${t(`scopes.${scope}`)}`}
                  />
                  <Label htmlFor={id} className="cursor-pointer text-xs">
                    {t(`scopes.${scope}`)}
                  </Label>
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

type EditorOutput = {
  name: string
  description?: string
  avatarColor: string
  avatarEmoji?: string
  systemPrompt: string
  model?: string
  modelRouting?: Character["modelRouting"]
  executionPolicy?: Character["executionPolicy"]
  permissionMode?: AppSettings["permissionMode"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  knowledgeBaseIds?: string[]
  memoryPolicy?: Character["memoryPolicy"]
  workingDir?: string
  bareMode?: boolean
  debugMode?: boolean
  briefMode?: boolean
  twinId?: string
  twinSettings?: Character["twinSettings"]
  enableComputerUse?: boolean
  enableBrowserTools?: boolean
  computerUseSettings?: Character["computerUseSettings"]
  computerUseTarget?: Character["computerUseTarget"]
  sandboxEnabled?: boolean
  sandboxTier?: SandboxShellTier
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
  knowledgeBaseCatalog: KnowledgeBase[]
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
  knowledgeBaseCatalog,
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
  const [envSecretValues, setEnvSecretValues] = useState<Record<string, string>>({})
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
    setEnvSecretValues({})
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
    const maxTurnsText = s.executionMaxTurns.trim()
    const maxTurns = maxTurnsText ? Number(maxTurnsText) : undefined
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) {
      toast.error(tEditor("execution.maxTurnsInvalid"))
      return
    }
    const envBindings = (s.executionEnvBindings ?? []).map((binding) => ({
      ...binding,
      name: binding.name.trim(),
    }))
    const envNames = new Set<string>()
    for (const binding of envBindings) {
      if (!isValidAgentEnvName(binding.name)) {
        toast.error(tEditor("execution.envNameInvalid", { name: binding.name || "?" }))
        return
      }
      if (envNames.has(binding.name)) {
        toast.error(tEditor("execution.envNameDuplicate", { name: binding.name }))
        return
      }
      envNames.add(binding.name)
    }
    const initialSecretRefs = new Set(
      (initial.executionEnvBindings ?? [])
        .filter(
          (binding): binding is Extract<AgentEnvBinding, { kind: "secret" }> =>
            binding.kind === "secret"
        )
        .map((binding) => binding.secretRef)
    )
    for (const binding of envBindings) {
      if (
        binding.kind === "secret" &&
        !initialSecretRefs.has(binding.secretRef) &&
        !envSecretValues[binding.secretRef]
      ) {
        toast.error(tEditor("execution.envSecretRequired", { name: binding.name }))
        return
      }
    }
    setSaving(true)
    try {
      for (const binding of envBindings) {
        if (binding.kind !== "secret") continue
        const value = envSecretValues[binding.secretRef]
        if (!value) continue
        try {
          await saveAgentEnvSecret(binding.secretRef, value)
        } catch (error) {
          log.error("agent_env_secret_save_failed", error, { name: binding.name })
          toast.error(tEditor("execution.envSecretSaveFailed", { name: binding.name }))
          return
        }
      }
      const allowed = parseChips(allowToolsText)
      const disallowed = parseChips(denyToolsText)
      const executeModel = s.model.trim() || undefined
      const planModel = s.planModel.trim() || undefined
      const utilityModel = s.utilityModel.trim() || undefined
      const modelRouting =
        planModel || executeModel || utilityModel
          ? { plan: planModel, execute: executeModel, utility: utilityModel }
          : undefined
      const executionEffort = s.executionEffort === "inherit" ? undefined : s.executionEffort
      const executionPolicy =
        executionEffort || maxTurns !== undefined || envBindings.length > 0
          ? {
              effort: executionEffort,
              maxTurns,
              envBindings: envBindings.length > 0 ? envBindings : undefined,
            }
          : undefined
      await onSave({
        name: s.name.trim(),
        description: s.description.trim() || undefined,
        avatarColor: s.avatarColor,
        avatarEmoji: s.avatarEmoji.trim() || undefined,
        systemPrompt: s.systemPrompt,
        // Keep the legacy column for older clients while semantic routing is
        // the new execution source of truth.
        model: executeModel,
        modelRouting,
        executionPolicy,
        permissionMode: s.permissionMode,
        allowedTools: allowed.length > 0 ? allowed : undefined,
        disallowedTools: disallowed.length > 0 ? disallowed : undefined,
        mcpServerIds: s.mcpServerIds,
        skillIds: s.skillIds.length > 0 ? s.skillIds : undefined,
        knowledgeBaseIds: s.knowledgeBaseIds.length > 0 ? s.knowledgeBaseIds : undefined,
        memoryPolicy: {
          operations: {
            recall: s.memoryRecall,
            create: s.memoryCreate,
            update: s.memoryUpdate,
            forget: s.memoryForget,
          },
          readableScopes: s.memoryReadableScopes,
          writableScopes: s.memoryWritableScopes,
          autoLearn: s.memoryAutoLearn,
        },
        workingDir: s.workingDir.trim() || undefined,
        bareMode: s.bareMode || undefined,
        debugMode: s.debugMode || undefined,
        briefMode: s.briefMode || undefined,
        twinId: s.twinId,
        twinSettings: s.twinSettings,
        enableComputerUse: s.enableComputerUse || undefined,
        enableBrowserTools: s.enableBrowserTools || undefined,
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
              <Button
                key={c}
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setS({ ...s, avatarColor: c })}
                className="size-4 rounded-full p-0 ring-1 ring-border"
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
              <Input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarFile}
                aria-label={tEditor("avatarImage.upload")}
              />
            </label>
            {s.avatarImageDataUrl && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-[10px] text-muted-foreground"
                onClick={() => setS({ ...s, avatarImageDataUrl: "" })}
              >
                {tEditor("avatarImage.clear")}
              </Button>
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

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div>
          <Label className="text-xs font-medium">{tEditor("routing.title")}</Label>
          <p className="text-[10px] text-muted-foreground">{tEditor("routing.description")}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("routing.plan")}</Label>
            <Input
              value={s.planModel}
              onChange={(e) => setS({ ...s, planModel: e.target.value })}
              placeholder={tEditor("routing.planPlaceholder")}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("routing.execute")}</Label>
            <Select
              value={s.model || "__default__"}
              onValueChange={(v) => setS({ ...s, model: v === "__default__" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{tEditor("useDefault")}</SelectItem>
                {modelPresetOptions().map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
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
            <Label className="text-xs">{tEditor("routing.utility")}</Label>
            <Input
              value={s.utilityModel}
              onChange={(e) => setS({ ...s, utilityModel: e.target.value })}
              placeholder={tEditor("routing.utilityPlaceholder")}
              className="font-mono text-xs"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("execution.effort")}</Label>
          <Select
            value={s.executionEffort}
            onValueChange={(value) =>
              setS({ ...s, executionEffort: value as EditorState["executionEffort"] })
            }
          >
            <SelectTrigger aria-label={tEditor("execution.effort")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tEditor("execution.inherit")}</SelectItem>
              {(["low", "medium", "high", "xhigh", "max"] as const).map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {tEditor(`execution.effortValues.${effort}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="agent-max-turns">
            {tEditor("execution.maxTurns")}
          </Label>
          <Input
            id="agent-max-turns"
            type="number"
            min={1}
            max={100}
            value={s.executionMaxTurns}
            onChange={(event) => setS({ ...s, executionMaxTurns: event.target.value })}
            placeholder={tEditor("execution.maxTurnsPlaceholder")}
          />
          <p className="text-[10px] text-muted-foreground">{tEditor("execution.maxTurnsHint")}</p>
        </div>
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="text-xs font-medium">{tEditor("execution.envTitle")}</Label>
            <p className="text-[10px] text-muted-foreground">
              {tEditor("execution.envDescription")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setS((current) => ({
                ...current,
                executionEnvBindings: [
                  ...(current.executionEnvBindings ?? []),
                  { name: "", kind: "plain", value: "" },
                ],
              }))
            }
          >
            <PlusIcon className="mr-1 size-3.5" />
            {tEditor("execution.addEnv")}
          </Button>
        </div>
        {(s.executionEnvBindings ?? []).map((binding, index) => {
          const rowId = `agent-env-${index}`
          return (
            <div
              key={`${binding.kind}-${binding.kind === "secret" ? binding.secretRef : index}`}
              className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_7.5rem_1fr_auto]"
            >
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${rowId}-name`}>
                  {tEditor("execution.envName")}
                </Label>
                <Input
                  id={`${rowId}-name`}
                  value={binding.name}
                  onChange={(event) =>
                    setS((current) => ({
                      ...current,
                      executionEnvBindings: (current.executionEnvBindings ?? []).map((item, i) =>
                        i === index ? { ...item, name: event.target.value } : item
                      ),
                    }))
                  }
                  placeholder={tEditor("execution.envNamePlaceholder")}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{tEditor("execution.envKind")}</Label>
                <Select
                  value={binding.kind}
                  onValueChange={(kind) =>
                    setS((current) => ({
                      ...current,
                      executionEnvBindings: (current.executionEnvBindings ?? []).map((item, i) => {
                        if (i !== index || item.kind === kind) return item
                        return kind === "secret"
                          ? {
                              name: item.name,
                              kind: "secret" as const,
                              secretRef: createAgentEnvSecretRef(
                                editingId ?? "new-agent",
                                item.name || "ENV"
                              ),
                            }
                          : { name: item.name, kind: "plain" as const, value: "" }
                      }),
                    }))
                  }
                >
                  <SelectTrigger aria-label={tEditor("execution.envKind")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plain">{tEditor("execution.envPlain")}</SelectItem>
                    <SelectItem value="secret">{tEditor("execution.envSecret")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${rowId}-value`}>
                  {tEditor("execution.envValue")}
                </Label>
                <Input
                  id={`${rowId}-value`}
                  type={binding.kind === "secret" ? "password" : "text"}
                  autoComplete={binding.kind === "secret" ? "new-password" : undefined}
                  value={
                    binding.kind === "secret"
                      ? (envSecretValues[binding.secretRef] ?? "")
                      : binding.value
                  }
                  onChange={(event) => {
                    if (binding.kind === "secret") {
                      setEnvSecretValues((current) => ({
                        ...current,
                        [binding.secretRef]: event.target.value,
                      }))
                      return
                    }
                    setS((current) => ({
                      ...current,
                      executionEnvBindings: (current.executionEnvBindings ?? []).map((item, i) =>
                        i === index && item.kind === "plain"
                          ? { ...item, value: event.target.value }
                          : item
                      ),
                    }))
                  }}
                  placeholder={
                    binding.kind === "secret"
                      ? tEditor("execution.envSecretPlaceholder")
                      : tEditor("execution.envPlainPlaceholder")
                  }
                  className="font-mono text-xs"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() =>
                  setS((current) => ({
                    ...current,
                    executionEnvBindings: (current.executionEnvBindings ?? []).filter(
                      (_, i) => i !== index
                    ),
                  }))
                }
                aria-label={tEditor("execution.removeEnv", { name: binding.name || "?" })}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          )
        })}
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
              onChange={(target) =>
                setS({
                  ...s,
                  computerUseTarget: target,
                  // Dropping back to the local desktop leaves `cua-desktop`
                  // with nothing to bind to, which would save a combination
                  // that can only ever be refused at send time. Fall back to
                  // inheriting rather than persisting an unusable tier.
                  sandboxTier:
                    target === "local" && s.sandboxTier === "cua-desktop"
                      ? "inherit"
                      : s.sandboxTier,
                })
              }
            />
          </>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="cursor-pointer text-xs">{t("browserToolsToggle.label")}</Label>
            <p className="text-[10px] text-muted-foreground">
              {t("browserToolsToggle.description")}
            </p>
          </div>
          <Switch
            checked={s.enableBrowserTools}
            onCheckedChange={(v) => setS({ ...s, enableBrowserTools: v })}
            aria-label={t("browserToolsToggle.aria")}
          />
        </div>
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
              <SelectItem value="cua-desktop" disabled>
                {tSandbox("tier.cuaDesktop")}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">{tSandbox("tier.description")}</p>
          {s.sandboxTier === "cua-desktop" && (
            <p className="text-[10px] text-destructive">{tSandbox("tier.cuaDesktopUnavailable")}</p>
          )}
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
        label={tEditor("knowledgeBases")}
        helpText={tEditor("knowledgeBasesHint")}
        items={knowledgeBaseCatalog.map((knowledgeBase) => ({
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
        }))}
        selectedIds={s.knowledgeBaseIds}
        allowEmpty
        emptyHint={tEditor("knowledgeBasesEmptyHint")}
        onChange={(ids) => setS({ ...s, knowledgeBaseIds: ids })}
      />

      <MemoryPolicyEditor state={s} onChange={setS} />

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
                {ORDERED_TTS_PROVIDERS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {TTS_PROVIDERS[provider].name}
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
                  <Input
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
              <Button
                key={it.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => toggle(it.id)}
                className={
                  "h-auto gap-1 rounded-pill px-2 py-0.5 text-xs font-normal " +
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
              </Button>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => move(id, -1)}
                  className="size-5 text-muted-foreground hover:text-foreground"
                  aria-label={tMS("moveUp", { name: it.name })}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => move(id, 1)}
                  className="size-5 text-muted-foreground hover:text-foreground"
                  aria-label={tMS("moveDown", { name: it.name })}
                >
                  ↓
                </Button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
