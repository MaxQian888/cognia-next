"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  FileTextIcon,
  ImageIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  createResource,
  deleteResource,
  listResourcesForSkill,
  updateResource,
  type SkillResourceDraft,
} from "@/lib/db/skill-resources"
import type { SkillResource, SkillResourceKind } from "@/lib/claude/types"
import { loggers } from "@/lib/logger"

interface Props {
  skillId: string
}

const KIND_ICON: Record<SkillResourceKind, typeof FileTextIcon> = {
  script: TerminalIcon,
  reference: FileTextIcon,
  asset: ImageIcon,
}

export function SkillResourceManager({ skillId }: Props) {
  const t = useTranslations("skills.resources")
  const resources = useLiveQuery(() => listResourcesForSkill(skillId), [skillId])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState<SkillResourceKind | null>(null)

  const handleCreate = async (draft: Omit<SkillResourceDraft, "skillId">) => {
    try {
      await createResource({ ...draft, skillId })
      toast.success(t("addedToast", { name: draft.name }))
      loggers.skills.info("resource create ok", { skillId, kind: draft.kind, name: draft.name })
      setCreating(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("resource create failed", err, { skillId, kind: draft.kind })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">{t("title")}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <PlusIcon className="mr-1.5 size-3.5" />
              {t("addGeneric")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setCreating("script")}>
              <TerminalIcon className="mr-2 size-3.5" />
              {t("addScript")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCreating("reference")}>
              <FileTextIcon className="mr-2 size-3.5" />
              {t("addReference")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCreating("asset")}>
              <ImageIcon className="mr-2 size-3.5" />
              {t("addAsset")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {creating && (
        <ResourceForm
          mode="create"
          initial={{
            name: "",
            path: "",
            content: "",
            kind: creating,
            inline: creating === "reference",
          }}
          onCancel={() => setCreating(null)}
          onSubmit={handleCreate}
        />
      )}

      {resources === undefined ? (
        <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t("loading")}
        </p>
      ) : resources.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t("emptyState", { title: t("title") })}
        </p>
      ) : (
        <div className="space-y-1.5">
          {resources?.map((r) => (
            <ResourceRow
              key={r.id}
              resource={r}
              editing={editingId === r.id}
              onEditStart={() => setEditingId(r.id)}
              onEditCancel={() => setEditingId(null)}
              onSave={async (patch) => {
                try {
                  await updateResource(r.id, patch)
                  setEditingId(null)
                  toast.success(t("updatedToast"))
                  loggers.skills.info("resource update ok", { skillId, resourceId: r.id })
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err))
                  loggers.skills.error("resource update failed", err, {
                    skillId,
                    resourceId: r.id,
                  })
                }
              }}
              onDelete={async () => {
                try {
                  await deleteResource(r.id)
                  toast.success(t("removedToast", { name: r.name }))
                  loggers.skills.info("resource delete ok", { skillId, resourceId: r.id })
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err))
                  loggers.skills.error("resource delete failed", err, {
                    skillId,
                    resourceId: r.id,
                  })
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ResourceRow({
  resource,
  editing,
  onEditStart,
  onEditCancel,
  onSave,
  onDelete,
}: {
  resource: SkillResource
  editing: boolean
  onEditStart: () => void
  onEditCancel: () => void
  onSave: (patch: Partial<SkillResource>) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const t = useTranslations("skills.resources")
  if (editing) {
    return (
      <ResourceForm
        mode="edit"
        initial={{
          name: resource.name,
          path: resource.path,
          content: resource.content,
          kind: resource.kind,
          inline: resource.inline,
          mimeType: resource.mimeType,
          encoding: resource.encoding,
        }}
        onCancel={onEditCancel}
        onSubmit={(draft) =>
          onSave({
            name: draft.name,
            path: draft.path,
            content: draft.content,
            kind: draft.kind,
            inline: draft.inline,
            mimeType: draft.mimeType,
            encoding: draft.encoding,
          })
        }
      />
    )
  }
  const Icon = KIND_ICON[resource.kind]
  return (
    <Card className="flex items-center gap-2 p-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{resource.name}</p>
        <p className="truncate text-[10px] text-muted-foreground">
          {resource.path} · {humanSize(resource.size)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onEditStart}
        aria-label={t("rename")}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-destructive hover:text-destructive"
        onClick={() => void onDelete()}
        aria-label={t("delete")}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </Card>
  )
}

interface ResourceFormState {
  name: string
  path: string
  content: string
  kind: SkillResourceKind
  inline?: boolean
  mimeType?: string
  encoding?: "utf-8" | "base64"
}

function ResourceForm({
  mode,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit"
  initial: ResourceFormState
  onSubmit: (draft: Omit<SkillResourceDraft, "skillId">) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("skills.resources")
  const [form, setForm] = useState<ResourceFormState>(initial)
  return (
    <Card className="space-y-2 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("name")}</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("namePlaceholder")}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("kind")}</Label>
          <Select
            value={form.kind}
            onValueChange={(v) => setForm({ ...form, kind: v as SkillResourceKind })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="script">{t("kindScript")}</SelectItem>
              <SelectItem value="reference">{t("kindReference")}</SelectItem>
              <SelectItem value="asset">{t("kindAsset")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("path")}</Label>
        <Input
          value={form.path}
          onChange={(e) => setForm({ ...form, path: e.target.value })}
          placeholder={t("pathPlaceholder")}
          className="h-8 font-mono text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("content")}</Label>
        <Textarea
          rows={8}
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          className="font-mono text-xs"
        />
      </div>
      <Label className="flex items-center gap-2 text-xs">
        <Switch
          checked={form.inline ?? false}
          onCheckedChange={(v) => setForm({ ...form, inline: v })}
        />
        {t("inline")}
        <span className="text-[10px] text-muted-foreground">({t("inlineHint")})</span>
      </Label>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void onSubmit({
              name: form.name.trim(),
              path: form.path.trim(),
              content: form.content,
              kind: form.kind,
              inline: form.inline,
              mimeType: form.mimeType,
              encoding: form.encoding ?? "utf-8",
            })
          }
        >
          {mode === "create" ? t("addGeneric") : t("save")}
        </Button>
      </div>
    </Card>
  )
}

function humanSize(size?: number): string {
  if (!size) return "0 B"
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
