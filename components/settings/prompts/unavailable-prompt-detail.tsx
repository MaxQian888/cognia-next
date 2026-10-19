"use client"

/**
 * Detail of a slot that holds overrides but has no definition here
 * (ADR-0236 §5.4): its plugin is disabled or uninstalled, or this version no
 * longer ships it. The user's text is shown and kept, exported with the
 * profile, and applied again when the plugin returns with a compatible
 * contract; nothing here can edit it, because there is no contract to check
 * an edit against. Each scope's binding can be removed for good.
 */

import { useState } from "react"
import { toast } from "sonner"
import { PackageXIcon, Trash2Icon } from "lucide-react"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { usePromptSlots } from "@/hooks/prompts/use-prompt-slots"
import type { PromptOverrideBindingRow } from "@/lib/db/prompt-overrides"
import { parsePluginPromptId } from "@/lib/prompts/plugin-prompts"
import { removePromptBinding } from "@/lib/prompts/service"
import { usePromptLabels } from "./use-prompt-labels"

export interface UnavailablePromptDetailProps {
  promptId: string
}

export function UnavailablePromptDetail({ promptId }: UnavailablePromptDetailProps) {
  const { t, entryTitle } = usePromptLabels()
  const slots = usePromptSlots(promptId)
  const [removing, setRemoving] = useState<PromptOverrideBindingRow | null>(null)
  const plugin = parsePluginPromptId(promptId)

  const remove = async (binding: PromptOverrideBindingRow) => {
    try {
      await removePromptBinding(binding)
      toast.success(t("unavailable.removed"))
    } catch (error) {
      toast.error(
        t("toast.failed", { message: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="unavailable-prompt-detail">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold">{entryTitle(promptId)}</h3>
        <p className="font-mono text-[11px] text-muted-foreground">{promptId}</p>
      </header>

      <Alert>
        <PackageXIcon className="size-4" />
        <AlertTitle>{t("unavailable.title")}</AlertTitle>
        <AlertDescription className="text-xs">
          {plugin ? t("unavailable.plugin", { plugin: plugin.pluginId }) : t("unavailable.retired")}
        </AlertDescription>
      </Alert>

      {slots === undefined ? (
        <p className="text-xs text-muted-foreground">{t("owner.loading")}</p>
      ) : (
        <ul className="space-y-3" aria-label={t("unavailable.slots")}>
          {slots
            .filter((slot) => slot.binding)
            .map(({ binding, active, draft }) => (
              <li key={binding!.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="text-[10px]">
                      {t(`scope.${binding!.scope}`)}
                    </Badge>
                    {binding!.targetId ? (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {binding!.targetId}
                      </span>
                    ) : null}
                    {draft ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("unavailable.hasDraft")}
                      </Badge>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setRemoving(binding!)}
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("unavailable.remove")}
                  </Button>
                </div>
                {active ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
                    {active.body}
                  </pre>
                ) : (
                  <p className="text-[11px] text-muted-foreground">{t("unavailable.noActive")}</p>
                )}
              </li>
            ))}
        </ul>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("unavailable.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("unavailable.confirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => removing && void remove(removing)}>
              {t("unavailable.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
