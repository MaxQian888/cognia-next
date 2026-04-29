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
import type { Character, McpServer, Team, TeamMember, TeamOrchestration } from "@/lib/claude/types"
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
import { avatarColor, avatarGlyph } from "@/lib/avatar"

const COLOR_PALETTE = [
  "oklch(0.74 0.16 90)",
  "oklch(0.7 0.16 200)",
  "oklch(0.7 0.13 150)",
  "oklch(0.65 0.18 245)",
  "oklch(0.7 0.15 30)",
  "oklch(0.7 0.14 320)",
]

const ORCHESTRATION_LABELS: Record<TeamOrchestration, string> = {
  mention_round_robin: "@mention + round-robin",
  round_robin: "Round-robin (always all)",
  manual: "Manual (user picks)",
  supervisor: "Supervisor (one leader dispatches)",
}

export function TeamsSection() {
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
            Teams
          </Label>
          <p className="text-xs text-muted-foreground">
            A team is a named bundle of characters that respond together in group chat. Use
            @CharacterName to address one member; otherwise every member replies once in declared
            order. Supervisor mode lets one leader dispatch sub-tasks to other members and
            synthesize.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null)
            setCreating(true)
          }}
          disabled={characters.length === 0}
          title={characters.length === 0 ? "Create a character first" : "Add a team"}
        >
          <PlusIcon className="mr-2 size-4" />
          New team
        </Button>
      </div>

      {teams.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          No teams yet. The built-in &quot;Brainstorm Squad&quot; should appear automatically.
        </p>
      ) : (
        <div className="grid gap-2">
          {teams.map((t) => (
            <TeamRow
              key={t.id}
              team={t}
              characters={characters}
              mcpServers={mcpServers}
              editing={editing?.id === t.id}
              onEditStart={() => setEditing(t)}
              onEditCancel={() => setEditing(null)}
              onSave={async (patch) => {
                await updateTeam(t.id, patch)
                setEditing(null)
                toast.success(`Updated ${patch.name ?? t.name}.`)
              }}
              onDelete={async () => {
                try {
                  await deleteTeam(t.id)
                  toast.success(`Removed "${t.name}".`)
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err))
                }
              }}
              onDuplicate={async () => {
                const dup = await duplicateTeam(t.id)
                toast.success(`Duplicated as "${dup.name}".`)
                setEditing(dup)
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
            supervisorCharacterId: undefined,
            mcpServerIds: undefined,
          }}
          characters={characters}
          mcpServers={mcpServers}
          submitLabel="Create"
          onCancel={() => setCreating(false)}
          onSave={async (data) => {
            await createTeam(data)
            setCreating(false)
            toast.success(`Added "${data.name}".`)
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
          supervisorCharacterId: team.supervisorCharacterId,
          mcpServerIds: team.mcpServerIds,
        }}
        characters={characters}
        mcpServers={mcpServers}
        submitLabel="Save"
        onCancel={onEditCancel}
        onSave={onSave}
      />
    )
  }

  const memberNames = team.members
    .map((m) => characters.find((c) => c.id === m.characterId)?.name ?? "(deleted)")
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
                Built-in
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              {ORCHESTRATION_LABELS[team.orchestration]}
            </Badge>
          </div>
          {team.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{team.description}</p>
          )}
          <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
            {team.members.length} member{team.members.length === 1 ? "" : "s"}: {memberNames}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEditStart}
            aria-label={`Edit ${team.name}`}
            disabled={team.isBuiltIn}
            title={team.isBuiltIn ? "Built-in teams are read-only — duplicate first" : "Edit"}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void onDuplicate()}
            aria-label={`Duplicate ${team.name}`}
            title="Duplicate"
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                aria-label={`Delete ${team.name}`}
                disabled={team.isBuiltIn}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove team?</AlertDialogTitle>
                <AlertDialogDescription>
                  &quot;{team.name}&quot; will be removed. Existing conversations stay but can no
                  longer route to this team.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onDelete()}>Remove</AlertDialogAction>
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
      toast.error("Name is required.")
      return
    }
    if (s.members.length === 0) {
      toast.error("A team needs at least one member.")
      return
    }
    if (s.orchestration === "supervisor") {
      if (!s.supervisorCharacterId) {
        toast.error("Supervisor mode requires a designated supervisor.")
        return
      }
      if (!memberIds.includes(s.supervisorCharacterId)) {
        toast.error("The supervisor must be one of the team's members.")
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
            placeholder="🧩"
            className="h-7 w-12 text-center"
            maxLength={4}
            aria-label="Avatar emoji"
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
                aria-label={`Pick color ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input
              value={s.name}
              onChange={(e) => setS({ ...s, name: e.target.value })}
              placeholder="Brainstorm Squad"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Textarea
              rows={2}
              value={s.description}
              onChange={(e) => setS({ ...s, description: e.target.value })}
              className="text-xs"
              placeholder="(optional)"
            />
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Orchestration</Label>
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
                {ORCHESTRATION_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {s.orchestration === "supervisor" && (
        <div className="space-y-1">
          <Label className="text-xs">Supervisor (the leader)</Label>
          <Select
            value={s.supervisorCharacterId ?? ""}
            onValueChange={(v) => setS({ ...s, supervisorCharacterId: v || undefined })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a member to be the leader" />
            </SelectTrigger>
            <SelectContent>
              {s.members.length === 0 && (
                <SelectItem value="__none" disabled>
                  Add members first
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
            The supervisor receives every user turn first and may either answer alone or emit{" "}
            <code>{`<dispatch to="Name">task</dispatch>`}</code> to delegate to teammates, then
            synthesize the final reply.
          </p>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs">Members (order = round-robin order)</Label>
        <div className="flex flex-wrap gap-1.5">
          {characters.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">Create a character first.</p>
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
            <span className="text-[11px] text-muted-foreground">Reorder:</span>
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
                    aria-label={`Move ${c.name} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(m.characterId, 1)}
                    className="px-1 text-muted-foreground hover:text-foreground"
                    aria-label={`Move ${c.name} down`}
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
              Member overrides ({countOverrides(s.members)} active)
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-1">
            <p className="text-[11px] text-muted-foreground">
              Each override replaces the corresponding character default for this team only. Leave
              blank to inherit. Skills always apply on top.
            </p>
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
        <Label className="text-xs">MCP servers (team-wide override)</Label>
        <p className="text-[11px] text-muted-foreground">
          Applies to members that don&apos;t set their own MCP subset. Leave all unselected to mean
          &quot;use every enabled server&quot;.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {mcpServers.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">No MCP servers configured.</p>
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
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : submitLabel}
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

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">Role label</Label>
          <Input
            value={member.role ?? ""}
            onChange={(e) => onPatch({ role: e.target.value || undefined })}
            placeholder="e.g. Critic"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">Model override</Label>
          <Input
            value={member.modelOverride ?? ""}
            onChange={(e) => onPatch({ modelOverride: e.target.value || undefined })}
            placeholder={character.model ?? "(inherit)"}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-[11px]">System prompt override</Label>
        <Textarea
          rows={3}
          value={member.systemPromptOverride ?? ""}
          onChange={(e) => onPatch({ systemPromptOverride: e.target.value || undefined })}
          placeholder="(inherits character system prompt)"
          className="text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[11px]">
          Allowed tools override (comma-separated; replaces character list)
        </Label>
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
            character.allowedTools?.length ? character.allowedTools.join(", ") : "(inherit)"
          }
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[11px]">MCP subset override</Label>
        <div className="flex flex-wrap gap-1">
          {mcpServers.length === 0 ? (
            <p className="text-[11px] italic text-muted-foreground">No MCP servers configured.</p>
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
          <p className="text-[10px] italic text-muted-foreground">
            Inherits character / team subset.
          </p>
        )}
      </div>
    </Card>
  )
}
