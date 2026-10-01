"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useInstalledPluginSummaries } from "@/hooks/plugins/use-cogsets"
import { createCogsetFromPlugins, editCogset } from "@/lib/plugin/cogset/actions"
import type { CogsetMember, CogsetRow } from "@/types/plugin/plugin-cogset"

export type CogsetEditorMode =
  { kind: "create" } | { kind: "save-current" } | { kind: "edit"; cogset: CogsetRow }

export interface CogsetEditorDialogProps {
  mode: CogsetEditorMode | null
  onOpenChange: (open: boolean) => void
  displayName: (cogset: Pick<CogsetRow, "name" | "source">) => string
  alwaysOn: readonly string[]
}

interface Draft {
  selected: boolean
  optional: boolean
  pin: boolean
}

/**
 * Create a cogset, save the running plugins as one, or edit one. Members keep
 * the config they already carry; a new member picks up the plugin's current
 * non-secret settings (done by the action, not here).
 */
export function CogsetEditorDialog({
  mode,
  onOpenChange,
  displayName,
  alwaysOn,
}: CogsetEditorDialogProps) {
  const t = useTranslations("plugins.cogsets.editor")
  const { plugins } = useInstalledPluginSummaries()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [query, setQuery] = useState("")
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [nameError, setNameError] = useState(false)
  const [saving, setSaving] = useState(false)
  const alwaysOnSet = useMemo(() => new Set(alwaysOn), [alwaysOn])

  // Seed the form whenever the dialog opens for a new target. "Save current"
  // preselects what runs now, so it re-seeds once the plugin list has loaded.
  const seedKey = mode
    ? mode.kind === "edit"
      ? `edit:${mode.cogset.id}`
      : mode.kind === "save-current"
        ? `save-current:${plugins.length > 0}`
        : mode.kind
    : null
  const [seededFor, setSeededFor] = useState<string | null>(null)
  if (seedKey !== seededFor) {
    setSeededFor(seedKey)
    setQuery("")
    setNameError(false)
    if (mode?.kind === "edit") {
      setName(mode.cogset.name)
      setDescription(mode.cogset.description ?? "")
      setDrafts(
        Object.fromEntries(
          mode.cogset.members.map((member) => [
            member.pluginId,
            { selected: true, optional: !!member.optional, pin: !!member.expectedVersion },
          ])
        )
      )
    } else {
      setName("")
      setDescription("")
      setDrafts(
        mode?.kind === "save-current"
          ? Object.fromEntries(
              plugins
                .filter((plugin) => plugin.enabled && !alwaysOnSet.has(plugin.id))
                .map((plugin) => [plugin.id, { selected: true, optional: false, pin: false }])
            )
          : {}
      )
    }
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? plugins.filter(
          (plugin) =>
            plugin.name.toLowerCase().includes(needle) || plugin.id.toLowerCase().includes(needle)
        )
      : plugins
  }, [plugins, query])

  const selectedIds = Object.entries(drafts)
    .filter(([, draft]) => draft.selected)
    .map(([id]) => id)

  const update = (pluginId: string, patch: Partial<Draft>) =>
    setDrafts((current) => ({
      ...current,
      [pluginId]: {
        ...(current[pluginId] ?? { selected: false, optional: false, pin: false }),
        ...patch,
      },
    }))

  const save = async () => {
    if (!mode) return
    if (!name.trim()) {
      setNameError(true)
      return
    }
    setSaving(true)
    try {
      const versionOf = new Map(plugins.map((plugin) => [plugin.id, plugin.version]))
      const shape = (member: CogsetMember): CogsetMember => {
        const draft = drafts[member.pluginId]
        const { expectedVersion: _pinned, optional: _optional, ...rest } = member
        const version = versionOf.get(member.pluginId) ?? member.expectedVersion
        return {
          ...rest,
          ...(draft?.optional ? { optional: true } : {}),
          ...(draft?.pin && version ? { expectedVersion: version } : {}),
        }
      }
      let saved: CogsetRow | undefined
      if (mode.kind === "edit") {
        const previous = new Map(mode.cogset.members.map((member) => [member.pluginId, member]))
        saved = await editCogset(mode.cogset.id, {
          name,
          description,
          members: selectedIds.map((pluginId) => shape(previous.get(pluginId) ?? { pluginId })),
        })
      } else {
        const created = await createCogsetFromPlugins({
          name,
          description,
          pluginIds: selectedIds,
          source: { kind: "manual" },
        })
        saved = await editCogset(created.id, { members: created.members.map(shape) })
      }
      toast.success(t("saved", { name: saved ? displayName(saved) : name }))
      onOpenChange(false)
    } catch (error) {
      toast.error(t("saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  const title =
    mode?.kind === "edit"
      ? t("editTitle", { name: displayName(mode.cogset) })
      : mode?.kind === "save-current"
        ? t("saveCurrentTitle")
        : t("createTitle")

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] w-[95vw] max-w-xl flex-col"
        data-testid="cogset-editor"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("selectedCount", { count: selectedIds.length })}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-1">
          <div className="space-y-1.5">
            <Label htmlFor="cogset-name">{t("name")}</Label>
            <Input
              id="cogset-name"
              value={name}
              placeholder={t("namePlaceholder")}
              aria-invalid={nameError}
              onChange={(event) => {
                setName(event.target.value)
                setNameError(false)
              }}
            />
            {nameError && (
              <p className="text-xs text-destructive" role="alert">
                {t("nameRequired")}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cogset-description">{t("description")}</Label>
            <Textarea
              id="cogset-description"
              value={description}
              placeholder={t("descriptionPlaceholder")}
              rows={2}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cogset-search">{t("plugins")}</Label>
            <Input
              id="cogset-search"
              type="search"
              value={query}
              placeholder={t("search")}
              onChange={(event) => setQuery(event.target.value)}
            />
            {visible.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{t("noResults")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {visible.map((plugin) => {
                  const draft = drafts[plugin.id]
                  const pinned = alwaysOnSet.has(plugin.id)
                  const checkboxId = `cogset-member-${plugin.id}`
                  return (
                    <li key={plugin.id} className="space-y-1.5 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={checkboxId}
                          checked={!!draft?.selected}
                          disabled={pinned}
                          onCheckedChange={(checked) =>
                            update(plugin.id, { selected: checked === true })
                          }
                        />
                        <Label
                          htmlFor={checkboxId}
                          className="min-w-0 flex-1 font-normal break-words"
                        >
                          {plugin.name}
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {plugin.version}
                          </span>
                        </Label>
                        {pinned && (
                          <Badge variant="secondary" title={t("alwaysOnHint")}>
                            {t("alwaysOnBadge")}
                          </Badge>
                        )}
                      </div>
                      {draft?.selected && !pinned && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-xs">
                          <label className="flex items-center gap-1.5" title={t("optionalHint")}>
                            <Checkbox
                              checked={draft.optional}
                              onCheckedChange={(checked) =>
                                update(plugin.id, { optional: checked === true })
                              }
                            />
                            {t("optional")}
                          </label>
                          <label className="flex items-center gap-1.5" title={t("pinHint")}>
                            <Checkbox
                              checked={draft.pin}
                              onCheckedChange={(checked) =>
                                update(plugin.id, { pin: checked === true })
                              }
                            />
                            {t("pin", { version: plugin.version })}
                          </label>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving} data-testid="cogset-editor-save">
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
