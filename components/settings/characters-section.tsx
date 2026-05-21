"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  listCharacters,
  updateCharacter,
} from "@/lib/db/characters"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listSkills } from "@/lib/db/skills"
import type { AppSettings, Character, McpServer, Skill } from "@/lib/claude/types"
import {
  TwinBindingSection,
  type TwinBindingValue,
} from "@/components/settings/character/twin-binding-section"
import { useLiveQuery } from "dexie-react-hooks"
import { CopyIcon, PencilIcon, PlusIcon, Trash2Icon, UsersRoundIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { createLogger } from "@/lib/logger"
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

export function CharactersSection() {
  const t = useTranslations("settings.characters")
  const characters = useLiveQuery(() => listCharacters(), []) ?? []
  const skills = useLiveQuery(() => listSkills(), []) ?? []
  const mcpServers = useLiveQuery(() => listMcpServers(), []) ?? []
  const [editing, setEditing] = useState<Character | null>(null)
  const [creating, setCreating] = useState(false)

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

      {characters.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("emptyHint")}
        </p>
      ) : (
        <div className="grid gap-2">
          {characters.map((c) => (
            <CharacterRow
              key={c.id}
              character={c}
              skills={skills}
              editing={editing?.id === c.id}
              onEditStart={() => setEditing(c)}
              onEditCancel={() => setEditing(null)}
              skillsCatalog={skills}
              mcpCatalog={mcpServers}
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
            />
          ))}
        </div>
      )}

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
            sandboxEnabled: false,
            sandboxTier: "inherit",
            accountIdOverride: "inherit",
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
}: RowProps) {
  const t = useTranslations("settings.characters")
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
          sandboxEnabled: Boolean(character.sandboxEnabled),
          sandboxTier: character.sandboxTier ?? "inherit",
          accountIdOverride: character.accountIdOverride ?? "inherit",
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

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-base"
          style={{
            backgroundColor: avatarColor(character),
            color: "white",
          }}
          aria-hidden
        >
          {avatarGlyph(character)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{character.name}</p>
            {character.isBuiltIn && (
              <Badge variant="secondary" className="text-[10px]">
                {t("builtIn")}
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
            disabled={character.isBuiltIn}
            title={character.isBuiltIn ? t("builtInReadOnly") : t("edit")}
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
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                aria-label={t("deleteAria", { name: character.name })}
                disabled={character.isBuiltIn}
                title={character.isBuiltIn ? t("builtInUndeletable") : t("delete")}
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

// --- Editor ---------------------------------------------------------------

type EditorState = {
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
  /** ADR-0028 Phase 10 — per-character sandbox enablement override. */
  sandboxEnabled: boolean
  /** ADR-0028 Phase 10 — `"inherit"` writes back as `undefined`. */
  sandboxTier: "os" | "microvm" | "inherit"
  /** ADR-0028 Phase 10 — account UUID from `ProviderVault::accounts[]`. */
  accountIdOverride: string | "inherit"
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
  sandboxEnabled?: boolean
  sandboxTier?: "os" | "microvm"
  accountIdOverride?: string
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

function CharacterEditor({
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
        sandboxEnabled: s.sandboxEnabled || undefined,
        sandboxTier: s.sandboxTier === "inherit" ? undefined : s.sandboxTier,
        accountIdOverride: s.accountIdOverride === "inherit" ? undefined : s.accountIdOverride,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <div className="flex flex-col items-center gap-2">
          <span
            className="flex size-12 items-center justify-center rounded-full text-lg"
            style={{
              backgroundColor: s.avatarColor || COLOR_PALETTE[0],
              color: "white",
            }}
            aria-hidden
          >
            {s.avatarEmoji?.trim() || s.name.slice(0, 1).toUpperCase() || "?"}
          </span>
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
