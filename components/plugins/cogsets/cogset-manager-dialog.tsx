"use client"

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CopyIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCcwIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { CogsetsView } from "@/hooks/plugins/use-cogsets"
import {
  createCogsetFromPlugins,
  editCogset,
  setGlobalCogset,
  setPluginAlwaysOn,
} from "@/lib/plugin/cogset/actions"
import { cn } from "@/lib/utils"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogsetOutcomeList } from "./cogset-outcome-list"

export interface CogsetManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  view: CogsetsView
  displayName: (cogset: Pick<CogsetRow, "name" | "source">) => string
  pluginName: (pluginId: string) => string
  isInstalled: (pluginId: string) => boolean
  onSwitch: (cogset: CogsetRow) => void
  onRetry: () => void
  onCreate: () => void
  onEdit: (cogset: CogsetRow) => void
  onDelete: (cogset: CogsetRow) => void
  /** Present when this host can export cogpacks. */
  onExport?: (cogset: CogsetRow) => void
}

export function CogsetManagerDialog(props: CogsetManagerDialogProps) {
  const { view, displayName, pluginName } = props
  const t = useTranslations("plugins.cogsets.manager")
  const format = useFormatter()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected =
    view.cogsets.find((cogset) => cogset.id === selectedId) ??
    view.effective?.cogset ??
    view.cogsets[0]
  const editable = !view.mirrored

  const guard = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (error) {
      toast.error(t("actionFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const sourceLabel = (cogset: CogsetRow) => {
    switch (cogset.source.kind) {
      case "default":
        return t("source.default")
      case "manual":
        return t("source.manual")
      case "preset":
        return t("source.preset", { name: cogset.source.presetName })
      case "cogpack":
        return t("source.cogpack", {
          name: cogset.source.cogpackId,
          version: cogset.source.version,
        })
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] w-[95vw] max-w-3xl flex-col"
        data-testid="cogset-manager"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {view.mirrored ? t("mirroredHint") : t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto sm:grid-cols-[14rem_1fr] sm:overflow-hidden">
          <div className="flex min-h-0 flex-col gap-2 sm:overflow-y-auto">
            {view.cogsets.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
              <ul className="space-y-1" aria-label={t("listAria")}>
                {view.cogsets.map((cogset) => (
                  <li key={cogset.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(cogset.id)}
                      aria-current={selected?.id === cogset.id}
                      className={cn(
                        "w-full rounded-md px-2 py-1.5 text-left text-sm break-words hover:bg-accent",
                        selected?.id === cogset.id && "bg-accent"
                      )}
                    >
                      {displayName(cogset)}
                      {view.applied?.id === cogset.id && (
                        <span className="ml-1.5 text-xs text-muted-foreground">{t("applied")}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <Button size="sm" variant="outline" onClick={props.onCreate}>
                <PlusIcon className="mr-1.5 size-3.5" />
                {t("new")}
              </Button>
            )}
          </div>

          {selected && (
            <section
              className="flex min-h-0 flex-col gap-3 sm:overflow-y-auto"
              data-testid="cogset-detail"
            >
              <div className="space-y-1">
                <h3 className="font-medium break-words">{displayName(selected)}</h3>
                {selected.description && (
                  <p className="text-sm break-words text-muted-foreground">
                    {selected.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {view.applied?.id === selected.id && <Badge>{t("applied")}</Badge>}
                  {view.state?.globalCogsetId === selected.id && (
                    <Badge variant="secondary">{t("global")}</Badge>
                  )}
                  {view.workspaceCogset?.id === selected.id && (
                    <Badge variant="secondary">{t("workspace")}</Badge>
                  )}
                  <Badge variant="outline">{sourceLabel(selected)}</Badge>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {view.applied?.id !== selected.id && (
                  <Button
                    size="sm"
                    onClick={() => props.onSwitch(selected)}
                    data-testid="cogset-manager-switch"
                  >
                    {t("switch")}
                  </Button>
                )}
                {editable && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => props.onEdit(selected)}>
                      <PencilIcon className="mr-1.5 size-3.5" />
                      {t("edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void guard(async () => {
                          const copy = await createCogsetFromPlugins({
                            name: t("duplicateName", { name: displayName(selected) }),
                            description: selected.description,
                            pluginIds: [],
                            source: { kind: "manual" },
                          })
                          await editCogset(copy.id, { members: selected.members })
                          setSelectedId(copy.id)
                        })
                      }
                    >
                      <CopyIcon className="mr-1.5 size-3.5" />
                      {t("duplicate")}
                    </Button>
                    {view.state?.globalCogsetId !== selected.id && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void guard(async () => {
                            await setGlobalCogset(selected.id)
                            toast.success(t("madeDefault", { name: displayName(selected) }))
                          })
                        }
                      >
                        <StarIcon className="mr-1.5 size-3.5" />
                        {t("makeDefault")}
                      </Button>
                    )}
                    {props.onExport && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => props.onExport?.(selected)}
                      >
                        <PackageIcon className="mr-1.5 size-3.5" />
                        {t("export")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => props.onDelete(selected)}
                    >
                      <Trash2Icon className="mr-1.5 size-3.5" />
                      {t("delete")}
                    </Button>
                  </>
                )}
              </div>

              {selected.lastApplied && (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">
                    {selected.lastApplied.status === "partial"
                      ? t("lastPartial")
                      : t("lastApplied", {
                          time: format.relativeTime(new Date(selected.lastApplied.at)),
                        })}
                  </p>
                  {selected.lastApplied.status === "partial" && (
                    <>
                      <CogsetOutcomeList
                        outcomes={selected.lastApplied.outcomes}
                        pluginName={pluginName}
                      />
                      {editable && view.applied?.id === selected.id && (
                        <Button size="sm" variant="outline" onClick={props.onRetry}>
                          <RefreshCcwIcon className="mr-1.5 size-3.5" />
                          {t("retry")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">{t("members")}</h4>
                {selected.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noMembers")}</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {selected.members.map((member) => (
                      <li
                        key={member.pluginId}
                        className="flex flex-wrap items-center gap-1.5 px-3 py-1.5"
                      >
                        <span className="min-w-0 flex-1 break-words">
                          {pluginName(member.pluginId)}
                        </span>
                        {member.expectedVersion && (
                          <Badge variant="outline">
                            {t("memberPinned", { version: member.expectedVersion })}
                          </Badge>
                        )}
                        {member.optional && <Badge variant="outline">{t("memberOptional")}</Badge>}
                        {!props.isInstalled(member.pluginId) && (
                          <Badge variant="destructive">{t("memberMissing")}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-1.5" data-testid="cogset-always-on">
                <h4 className="text-sm font-medium">{t("alwaysOnTitle")}</h4>
                <p className="text-xs text-muted-foreground">{t("alwaysOnDescription")}</p>
                {(view.state?.alwaysOn.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("alwaysOnEmpty")}</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {view.state!.alwaysOn.map((pluginId) => (
                      <li key={pluginId}>
                        <Badge variant="secondary" className="gap-1">
                          {pluginName(pluginId)}
                          {editable && (
                            <button
                              type="button"
                              aria-label={t("alwaysOnRemove", { name: pluginName(pluginId) })}
                              onClick={() => void guard(() => setPluginAlwaysOn(pluginId, false))}
                            >
                              <XIcon className="size-3" />
                            </button>
                          )}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
