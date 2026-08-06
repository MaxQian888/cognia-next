"use client"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { listCharacters } from "@/lib/db/characters"
import { listMcpServers } from "@/lib/db/mcp-servers"
import {
  TEAM_ORCHESTRATIONS,
  createTeam,
  deleteTeam,
  duplicateTeam,
  listTeams,
  updateTeam,
} from "@/lib/db/teams"
import type {
  Character,
  McpServer,
  Team,
  TeamMember,
  TeamOrchestration,
} from "@cognia/agent-config-types"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronDownIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.teams")

const COLOR_PALETTE = [
  "oklch(0.74 0.16 90)",
  "oklch(0.7 0.16 200)",
  "oklch(0.7 0.13 150)",
  "oklch(0.65 0.18 245)",
  "oklch(0.7 0.15 30)",
  "oklch(0.7 0.14 320)",
]

export function TeamsSection() {
  const t = useTranslations("settings.teams")
  const teams = useLiveQuery(() => listTeams(), []) ?? []
  const characters = useLiveQuery(() => listCharacters(), []) ?? []
  const mcpServers = useLiveQuery(() => listMcpServers(), []) ?? []
  const [editing, setEditing] = useState<Team | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <UsersIcon className="size-4" />
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
          disabled={characters.length === 0}
          title={characters.length === 0 ? t("createCharacterFirst") : t("addATeam")}
        >
          <PlusIcon className="mr-2 size-4" />
          {t("newTeam")}
        </Button>
      </div>

      {teams.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("emptyHint")}
        </p>
      ) : (
        <div className="grid gap-2">
          {teams.map((tm) => (
            <TeamRow
              key={tm.id}
              team={tm}
              characters={characters}
              mcpServers={mcpServers}
              editing={editing?.id === tm.id}
              onEditStart={() => setEditing(tm)}
              onEditCancel={() => setEditing(null)}
              onSave={async (patch) => {
                try {
                  await updateTeam(tm.id, patch)
                  log.info("team_updated", { id: tm.id })
                  setEditing(null)
                  toast.success(t("updatedToast", { name: patch.name ?? tm.name }))
                } catch (err) {
                  log.error("team_update_failed", err, { id: tm.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onDelete={async () => {
                try {
                  await deleteTeam(tm.id)
                  log.info("team_deleted", { id: tm.id })
                  toast.success(t("removedToast", { name: tm.name }))
                } catch (err) {
                  log.error("team_delete_failed", err, { id: tm.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onDuplicate={async () => {
                try {
                  const dup = await duplicateTeam(tm.id)
                  log.info("team_duplicated", { sourceId: tm.id, newId: dup.id })
                  toast.success(t("duplicatedToast", { name: dup.name }))
                  setEditing(dup)
                } catch (err) {
                  log.error("team_duplicate_failed", err, { id: tm.id })
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
            />
          ))}
        </div>
      )}

      {creating && (
        <TeamEditor
          initial={{
            name: "",
            description: "",
            avatarColor: COLOR_PALETTE[0],
            avatarEmoji: "🧩",
            members: [],
            orchestration: "mention_round_robin",
            responseCap: "4",
            supervisorCharacterId: undefined,
            mcpServerIds: undefined,
          }}
          characters={characters}
          mcpServers={mcpServers}
          submitLabel={t("create")}
          onCancel={() => setCreating(false)}
          onSave={async (data) => {
            try {
              await createTeam(data)
              log.info("team_created", { name: data.name, orchestration: data.orchestration })
              setCreating(false)
              toast.success(t("addedToast", { name: data.name }))
            } catch (err) {
              log.error("team_create_failed", err)
              toast.error(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}
    </div>
  )
}

interface RowProps {
  team: Team
  characters: Character[]
  mcpServers: McpServer[]
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: EditorOutput) => Promise<void>
  onDelete: () => Promise<void>
  onDuplicate: () => Promise<void>
}

function TeamRow({
  team,
  characters,
  mcpServers,
  editing,
  onEditStart,
  onEditCancel,
  onSave,
  onDelete,
  onDuplicate,
}: RowProps) {
  const t = useTranslations("settings.teams")
  const tOrch = useTranslations("settings.teams.orchestration")
  if (editing) {
    return (
      <TeamEditor
        initial={{
          name: team.name,
          description: team.description ?? "",
          avatarColor: team.avatarColor,
          avatarEmoji: team.avatarEmoji ?? "",
          members: team.members.map((m) => ({ ...m })),
          orchestration: team.orchestration,
          responseCap: (team.maxResponses ?? 4).toString(),
          supervisorCharacterId: team.supervisorCharacterId,
          mcpServerIds: team.mcpServerIds,
        }}
        characters={characters}
        mcpServers={mcpServers}
        submitLabel={t("save")}
        onCancel={onEditCancel}
        onSave={onSave}
      />
    )
  }

  const memberNames = team.members
    .map((m) => characters.find((c) => c.id === m.characterId)?.name ?? t("memberDeleted"))
    .join(" · ")

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-base"
          style={{
            backgroundColor: avatarColor(team),
            color: "white",
          }}
          aria-hidden
        >
          {avatarGlyph(team)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{team.name}</p>
            {team.isBuiltIn && (
              <Badge variant="secondary" className="text-[10px]">
                {t("builtIn")}
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              {tOrch(team.orchestration as TeamOrchestration)}
            </Badge>
          </div>
          {team.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{team.description}</p>
          )}
          <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
            {t("memberCount", { count: team.members.length, names: memberNames })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            aria-label={t("editAria", { name: team.name })}
            disabled={team.isBuiltIn}
            title={team.isBuiltIn ? t("builtInReadOnly") : t("edit")}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void onDuplicate()}
            aria-label={t("duplicateAria", { name: team.name })}
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
                aria-label={t("deleteAria", { name: team.name })}
                disabled={team.isBuiltIn}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("removeBody", { name: team.name })}
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
  members: TeamMember[]
  orchestration: TeamOrchestration
  responseCap: string
  supervisorCharacterId: string | undefined
  mcpServerIds: string[] | undefined
}

type EditorOutput = {
  name: string
  description?: string
  avatarColor: string
  avatarEmoji?: string
  members: TeamMember[]
  orchestration: TeamOrchestration
  maxResponses?: number
  supervisorCharacterId?: string
  mcpServerIds?: string[]
}

interface EditorProps {
  initial: EditorState
  characters: Character[]
  mcpServers: McpServer[]
  submitLabel: string
  onCancel: () => void
  onSave: (data: EditorOutput) => Promise<void>
}

function TeamEditor({
  initial,
  characters,
  mcpServers,
  submitLabel,
  onCancel,
  onSave,
}: EditorProps) {
  const t = useTranslations("settings.teams")
  const tEditor = useTranslations("settings.teams.editor")
  const tOrch = useTranslations("settings.teams.orchestration")
  const tMS = useTranslations("settings.characters.multiselect")
  const [s, setS] = useState<EditorState>(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setS(initial)
  }, [initial])

  const memberIds = s.members.map((m) => m.characterId)

  const toggleMember = (id: string) => {
    if (memberIds.includes(id)) {
      const next = s.members.filter((m) => m.characterId !== id)
      const patch: Partial<EditorState> = { members: next }
      if (s.supervisorCharacterId === id) {
        patch.supervisorCharacterId = undefined
      }
      setS({ ...s, ...patch })
    } else {
      setS({ ...s, members: [...s.members, { characterId: id }] })
    }
  }

  const move = (id: string, dir: -1 | 1) => {
    const idx = memberIds.indexOf(id)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= s.members.length) return
    const next = [...s.members]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setS({ ...s, members: next })
  }

  const updateMember = (characterId: string, patch: Partial<Omit<TeamMember, "characterId">>) => {
    setS({
      ...s,
      members: s.members.map((m) => (m.characterId === characterId ? { ...m, ...patch } : m)),
    })
  }

  const submit = async () => {
    if (!s.name.trim()) {
      toast.error(t("validation.nameRequired"))
      return
    }
    if (s.members.length === 0) {
      toast.error(t("validation.atLeastOneMember"))
      return
    }
    const responseCap = Number(s.responseCap)
    if (!Number.isInteger(responseCap) || responseCap < 1 || responseCap > 12) {
      toast.error(t("validation.responseCapInvalid"))
      return
    }
    if (s.orchestration === "supervisor") {
      if (!s.supervisorCharacterId) {
        toast.error(t("validation.supervisorRequired"))
        return
      }
      if (!memberIds.includes(s.supervisorCharacterId)) {
        toast.error(t("validation.supervisorMustBeMember"))
        return
      }
    }
    setSaving(true)
    try {
      await onSave({
        name: s.name.trim(),
        description: s.description.trim() || undefined,
        avatarColor: s.avatarColor,
        avatarEmoji: s.avatarEmoji.trim() || undefined,
        members: s.members,
        orchestration: s.orchestration,
        maxResponses: responseCap,
        supervisorCharacterId:
          s.orchestration === "supervisor" ? s.supervisorCharacterId : undefined,
        mcpServerIds: s.mcpServerIds,
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
          <div className="grid grid-cols-3 gap-1">
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
            <Textarea
              rows={2}
              value={s.description}
              onChange={(e) => setS({ ...s, description: e.target.value })}
              className="text-xs"
              placeholder={tEditor("descriptionPlaceholder")}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("orchestration")}</Label>
        <Select
          value={s.orchestration}
          onValueChange={(v) => setS({ ...s, orchestration: v as TeamOrchestration })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEAM_ORCHESTRATIONS.map((o) => (
              <SelectItem key={o} value={o}>
                {tOrch(o as TeamOrchestration)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="team-response-cap">
          {tEditor("responseCap")}
        </Label>
        <Input
          id="team-response-cap"
          type="number"
          min={1}
          max={12}
          value={s.responseCap}
          onChange={(event) => setS({ ...s, responseCap: event.target.value })}
          aria-describedby="team-response-cap-help"
        />
        <p id="team-response-cap-help" className="text-[11px] text-muted-foreground">
          {tEditor("responseCapHelp")}
        </p>
      </div>

      {s.orchestration === "supervisor" && (
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("supervisor")}</Label>
          <Select
            value={s.supervisorCharacterId ?? ""}
            onValueChange={(v) => setS({ ...s, supervisorCharacterId: v || undefined })}
          >
            <SelectTrigger>
              <SelectValue placeholder={tEditor("supervisorPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {s.members.length === 0 && (
                <SelectItem value="__none" disabled>
                  {tEditor("addMembersFirst")}
                </SelectItem>
              )}
              {s.members.map((m) => {
                const c = characters.find((x) => x.id === m.characterId)
                if (!c) return null
                return (
                  <SelectItem key={m.characterId} value={m.characterId}>
                    {c.name}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {tEditor("supervisorHelpBefore")}
            <code>{`<dispatch to="Name">task</dispatch>`}</code>
            {tEditor("supervisorHelpAfter")}
          </p>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("members")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {characters.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">{tEditor("membersEmpty")}</p>
          ) : (
            characters.map((c) => {
              const active = memberIds.includes(c.id)
              const order = active ? memberIds.indexOf(c.id) + 1 : null
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleMember(c.id)}
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors " +
                    (active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted")
                  }
                >
                  <span
                    className="flex size-4 items-center justify-center rounded-full text-[9px]"
                    style={{
                      backgroundColor: avatarColor(c),
                      color: "white",
                    }}
                    aria-hidden
                  >
                    {avatarGlyph(c)}
                  </span>
                  {order !== null && (
                    <span className="font-mono text-[10px] text-muted-foreground">#{order}</span>
                  )}
                  {c.name}
                </button>
              )
            })
          )}
        </div>
        {s.members.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] text-muted-foreground">{tMS("reorder")}</span>
            {s.members.map((m) => {
              const c = characters.find((x) => x.id === m.characterId)
              if (!c) return null
              return (
                <span
                  key={m.characterId}
                  className="inline-flex items-center gap-0.5 rounded border bg-background px-1 text-[11px]"
                >
                  {c.name}
                  <button
                    type="button"
                    onClick={() => move(m.characterId, -1)}
                    className="px-1 text-muted-foreground hover:text-foreground"
                    aria-label={tEditor("moveUp", { name: c.name })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(m.characterId, 1)}
                    className="px-1 text-muted-foreground hover:text-foreground"
                    aria-label={tEditor("moveDown", { name: c.name })}
                  >
                    ↓
                  </button>
                </span>
              )
            })}
          </div>
        )}
      </div>

      {s.members.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex w-full items-center gap-1.5 rounded-md py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
              {tEditor("memberOverrides", { count: countOverrides(s.members) })}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-1">
            <p className="text-[11px] text-muted-foreground">{tEditor("overrideHelp")}</p>
            {s.members.map((m) => {
              const c = characters.find((x) => x.id === m.characterId)
              if (!c) return null
              return (
                <MemberOverrideCard
                  key={m.characterId}
                  character={c}
                  member={m}
                  mcpServers={mcpServers}
                  onPatch={(patch) => updateMember(m.characterId, patch)}
                />
              )
            })}
          </CollapsibleContent>
        </Collapsible>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("mcpTeam")}</Label>
        <p className="text-[11px] text-muted-foreground">{tEditor("mcpTeamHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {mcpServers.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">{tEditor("mcpEmpty")}</p>
          ) : (
            mcpServers.map((m) => {
              const active = (s.mcpServerIds ?? []).includes(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    const cur = new Set(s.mcpServerIds ?? [])
                    if (cur.has(m.id)) cur.delete(m.id)
                    else cur.add(m.id)
                    const next = [...cur]
                    setS({
                      ...s,
                      mcpServerIds: next.length === 0 ? undefined : next,
                    })
                  }}
                  className={
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors " +
                    (active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted")
                  }
                >
                  {m.name}
                </button>
              )
            })
          )}
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

function countOverrides(members: TeamMember[]): number {
  let n = 0
  for (const m of members) {
    if (m.role && m.role.trim()) n++
    if (m.systemPromptOverride && m.systemPromptOverride.trim()) n++
    if (m.modelOverride && m.modelOverride.trim()) n++
    if (m.allowedToolsOverride && m.allowedToolsOverride.length > 0) n++
    if (m.mcpServerIdsOverride && m.mcpServerIdsOverride.length > 0) n++
  }
  return n
}

interface MemberOverrideProps {
  character: Character
  member: TeamMember
  mcpServers: McpServer[]
  onPatch: (patch: Partial<Omit<TeamMember, "characterId">>) => void
}

function MemberOverrideCard({ character, member, mcpServers, onPatch }: MemberOverrideProps) {
  const tEditor = useTranslations("settings.teams.editor")
  return (
    <Card className="space-y-2 border-dashed bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span
          className="flex size-6 items-center justify-center rounded-full text-xs"
          style={{ backgroundColor: avatarColor(character), color: "white" }}
          aria-hidden
        >
          {avatarGlyph(character)}
        </span>
        <span className="text-sm font-medium">{character.name}</span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{tEditor("role")}</Label>
          <Input
            value={member.role ?? ""}
            onChange={(e) => onPatch({ role: e.target.value || undefined })}
            placeholder={tEditor("rolePlaceholder")}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{tEditor("modelOverride")}</Label>
          <Input
            value={member.modelOverride ?? ""}
            onChange={(e) => onPatch({ modelOverride: e.target.value || undefined })}
            placeholder={character.model ?? tEditor("modelOverrideInheritPlaceholder")}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-[11px]">{tEditor("systemPromptOverride")}</Label>
        <Textarea
          rows={3}
          value={member.systemPromptOverride ?? ""}
          onChange={(e) => onPatch({ systemPromptOverride: e.target.value || undefined })}
          placeholder={tEditor("systemPromptOverridePlaceholder")}
          className="text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[11px]">{tEditor("allowedToolsOverride")}</Label>
        <Input
          value={(member.allowedToolsOverride ?? []).join(", ")}
          onChange={(e) => {
            const parts = e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
            onPatch({
              allowedToolsOverride: parts.length === 0 ? undefined : parts,
            })
          }}
          placeholder={
            character.allowedTools?.length
              ? character.allowedTools.join(", ")
              : tEditor("modelOverrideInheritPlaceholder")
          }
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[11px]">{tEditor("mcpSubsetOverride")}</Label>
        <div className="flex flex-wrap gap-1">
          {mcpServers.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">{tEditor("mcpEmpty")}</p>
          ) : (
            mcpServers.map((srv) => {
              const cur = member.mcpServerIdsOverride ?? null
              const active = cur?.includes(srv.id) ?? false
              return (
                <button
                  key={srv.id}
                  type="button"
                  onClick={() => {
                    const next = new Set(cur ?? [])
                    if (next.has(srv.id)) next.delete(srv.id)
                    else next.add(srv.id)
                    const arr = [...next]
                    onPatch({
                      mcpServerIdsOverride: arr.length === 0 ? undefined : arr,
                    })
                  }}
                  className={
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] transition-colors " +
                    (active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted")
                  }
                >
                  {srv.name}
                </button>
              )
            })
          )}
        </div>
        {!member.mcpServerIdsOverride && (
          <p className="text-[10px] italic text-muted-foreground">{tEditor("inheritsFromTeam")}</p>
        )}
      </div>
    </Card>
  )
}
