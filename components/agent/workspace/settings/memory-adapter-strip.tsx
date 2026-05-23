"use client"

/**
 * Header strip for the Memory section: shows the team's configured
 * shared-memory adapter, lets the operator pick one (or none), and triggers a
 * reverse sync ("Sync now") that pulls remote changes into the local store.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  listSharedMemoryAdapterEntries,
  getSharedMemoryAdapter,
} from "@/lib/plugin/registries/shared-memory-adapter-registry"
import { syncSharedMemoryFromAdapter } from "@/lib/ai/agent/team/shared-memory-orchestrator"
import type { AgentTeam } from "@/types/agent/agent-team"
import { markSettingsSaved } from "./settings-save-indicator"

export interface MemoryAdapterStripProps {
  team: AgentTeam
}

const NONE_VALUE = "__none__"

export function MemoryAdapterStrip({ team }: MemoryAdapterStripProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.memory.adapter")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState<string>(team.config.sharedMemoryAdapterId ?? NONE_VALUE)
  const [syncing, setSyncing] = useState(false)

  const adapterId = team.config.sharedMemoryAdapterId
  const adapter = adapterId ? getSharedMemoryAdapter(adapterId) : undefined
  const entries = listSharedMemoryAdapterEntries()

  const saveAdapter = () => {
    updateTeamConfig(team.id, {
      ...team.config,
      sharedMemoryAdapterId: draft === NONE_VALUE ? undefined : draft,
    })
    markSettingsSaved()
    setPickerOpen(false)
  }

  const handleSync = async () => {
    if (!adapterId) return
    setSyncing(true)
    try {
      const { pulled } = await syncSharedMemoryFromAdapter(team.id)
      toast.success(t("synced", { count: pulled }))
    } catch {
      toast.error(t("syncFailed"))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">{t("label")}</span>
        <Badge variant="outline" className="text-[10px]">
          {adapter?.name ?? t("noAdapter")}
        </Badge>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setDraft(team.config.sharedMemoryAdapterId ?? NONE_VALUE)
            setPickerOpen(true)
          }}
        >
          {t("configure")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!adapterId || syncing}
          onClick={() => void handleSync()}
        >
          <RefreshCwIcon className="size-3.5" />
          {t("sync")}
        </Button>
      </div>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("pickerTitle")}</DialogTitle>
          </DialogHeader>
          <Select value={draft} onValueChange={setDraft}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>{t("unset")}</SelectItem>
              {entries.map(({ id, entry }) => (
                <SelectItem key={id} value={id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button size="sm" onClick={saveAdapter}>
              {t("configure")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
