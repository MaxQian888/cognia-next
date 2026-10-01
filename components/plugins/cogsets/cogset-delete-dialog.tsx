"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { usePluginUninstall } from "@/hooks/plugins/use-plugin-uninstall"
import { CogsetInUseError, listPluginsOnlyIn, removeCogset } from "@/lib/plugin/cogset/actions"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

export interface CogsetDeleteDialogProps {
  cogset: CogsetRow | null
  onOpenChange: (open: boolean) => void
  displayName: (cogset: Pick<CogsetRow, "name" | "source">) => string
  pluginName: (pluginId: string) => string
}

/**
 * Delete a cogset. Deleting never uninstalls on its own: the plugins that only
 * this cogset used are listed, unchecked, for the user to opt into removing.
 */
export function CogsetDeleteDialog({
  cogset,
  onOpenChange,
  displayName,
  pluginName,
}: CogsetDeleteDialogProps) {
  const t = useTranslations("plugins.cogsets.delete")
  const uninstall = usePluginUninstall()
  const [orphans, setOrphans] = useState<string[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!cogset) return
    void listPluginsOnlyIn(cogset.id).then((ids) => {
      if (cancelled) return
      setOrphans(ids)
      setChosen(new Set())
    })
    return () => {
      cancelled = true
    }
  }, [cogset])

  const name = cogset ? displayName(cogset) : ""

  const confirm = async () => {
    if (!cogset) return
    setBusy(true)
    try {
      await removeCogset(cogset.id)
    } catch (error) {
      toast.error(t("failed", { name }), {
        description:
          error instanceof CogsetInUseError
            ? t(error.reason === "applied" ? "inUseApplied" : "inUseGlobal")
            : error instanceof Error
              ? error.message
              : String(error),
      })
      setBusy(false)
      return
    }
    for (const pluginId of chosen) {
      await uninstall({ pluginId, name: pluginName(pluginId) })
    }
    toast.success(t("deleted", { name }))
    setBusy(false)
    onOpenChange(false)
  }

  return (
    <AlertDialog open={cogset !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="cogset-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        {orphans.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm">{t("orphans")}</p>
            <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border p-2">
              {orphans.map((pluginId) => {
                const id = `cogset-orphan-${pluginId}`
                return (
                  <li key={pluginId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={id}
                      checked={chosen.has(pluginId)}
                      onCheckedChange={(checked) =>
                        setChosen((current) => {
                          const next = new Set(current)
                          if (checked === true) next.add(pluginId)
                          else next.delete(pluginId)
                          return next
                        })
                      }
                    />
                    <label htmlFor={id} className="break-words">
                      {pluginName(pluginId)}
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            data-testid="cogset-delete-confirm"
            onClick={(event) => {
              event.preventDefault()
              void confirm()
            }}
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
