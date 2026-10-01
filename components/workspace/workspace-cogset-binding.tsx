"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CogIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCogsetDisplayName, useCogsets } from "@/hooks/plugins/use-cogsets"
import { setWorkspaceCogset } from "@/lib/plugin/cogset/actions"
import { useProjectStore } from "@/stores/project/project-store"

/** The select's value for "no binding". Not a valid cogset id (they start `cogset_`). */
const FOLLOW_GLOBAL = "__global__"

/**
 * Which cogset a workspace runs (ADR-0209). Opening the workspace makes it the
 * effective cogset and the host reconciles to it; without a binding the
 * workspace follows the global choice.
 */
export function WorkspaceCogsetBinding({ workspaceId }: { workspaceId?: string | null }) {
  const t = useTranslations("workspace.capabilities.cogset")
  const view = useCogsets()
  const displayName = useCogsetDisplayName()
  const bound = useProjectStore(
    (state) => state.projects.find((project) => project.id === workspaceId)?.pluginCogsetId
  )
  const global = view.cogsets.find((cogset) => cogset.id === view.state?.globalCogsetId)
  const disabled = !workspaceId || view.mirrored || view.loading

  const change = async (value: string) => {
    if (!workspaceId) return
    const cogsetId = value === FOLLOW_GLOBAL ? undefined : value
    try {
      await setWorkspaceCogset(workspaceId, cogsetId)
      const chosen = view.cogsets.find((cogset) => cogset.id === cogsetId)
      toast.success(chosen ? t("saved", { name: displayName(chosen) }) : t("cleared"))
    } catch (error) {
      toast.error(t("failed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // A binding to a deleted cogset reads as following the default, which is
  // what the follower does with it.
  const value = bound && view.cogsets.some((cogset) => cogset.id === bound) ? bound : FOLLOW_GLOBAL

  return (
    <ConsoleSection
      id="capabilities-cogset"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={CogIcon}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-1.5 px-3.5 py-3">
        <Label htmlFor="workspace-cogset">{t("label")}</Label>
        <Select value={value} onValueChange={(next) => void change(next)} disabled={disabled}>
          <SelectTrigger
            id="workspace-cogset"
            className="w-full sm:w-72"
            data-testid="workspace-cogset-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_GLOBAL}>
              {global ? t("followGlobal", { name: displayName(global) }) : t("followGlobalNone")}
            </SelectItem>
            {view.cogsets.map((cogset) => (
              <SelectItem key={cogset.id} value={cogset.id}>
                {displayName(cogset)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!workspaceId && <p className="text-xs text-muted-foreground">{t("noWorkspace")}</p>}
        {workspaceId && view.mirrored && (
          <p className="text-xs text-muted-foreground">{t("mirrored")}</p>
        )}
      </div>
    </ConsoleSection>
  )
}
