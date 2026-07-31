"use client"

import { useTranslations } from "next-intl"
import { RefreshCwIcon, AlertCircleIcon, CheckCircle2Icon, CircleDashedIcon } from "lucide-react"
import { useSkillSync } from "@/hooks/skills"
import { isTauri } from "@/lib/tauri"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { Skill } from "@cognia/agent-config-types"

type SyncStatus = "synced" | "outOfSync" | "error" | "never"

interface Props {
  skill: Skill
}

export function SkillSyncSection({ skill }: Props) {
  const t = useTranslations("skills.sync")
  const { busy, pushOne } = useSkillSync()
  const tauriEnv = isTauri()

  if (!tauriEnv) {
    return (
      <div
        data-testid="skill-sync-section"
        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      >
        {t("desktopOnly")}
      </div>
    )
  }

  const status: SyncStatus = skill.lastSyncError
    ? "error"
    : !skill.nativeDirectory
      ? "never"
      : skill.syncFingerprint
        ? "synced"
        : "outOfSync"

  return (
    <div data-testid="skill-sync-section" className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2">
        <StatusPill status={status} label={t(`status.${status}`)} />
        {skill.lastSyncedAt && (
          <span className="text-[11px] text-muted-foreground">
            {t("lastAt", { when: new Date(skill.lastSyncedAt).toLocaleString() })}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant={status === "error" ? "destructive" : "outline"}
            onClick={() => void pushOne(skill.id)}
            disabled={busy}
          >
            <RefreshCwIcon className="mr-1 size-3.5" />
            {status === "error" ? t("retry") : t("syncNow")}
          </Button>
        </div>
      </div>
      {skill.lastSyncError && <p className="text-xs text-destructive">{skill.lastSyncError}</p>}
    </div>
  )
}

function StatusPill({ status, label }: { status: SyncStatus; label: string }) {
  const map = {
    synced: { icon: CheckCircle2Icon, cls: "text-emerald-600 border-emerald-300" },
    outOfSync: { icon: RefreshCwIcon, cls: "text-amber-600 border-amber-300" },
    error: { icon: AlertCircleIcon, cls: "text-destructive border-destructive/40" },
    never: { icon: CircleDashedIcon, cls: "text-muted-foreground" },
  }[status]
  const Icon = map.icon
  return (
    <Badge variant="outline" className={`gap-1 ${map.cls}`}>
      <Icon className="size-3" />
      <span className="text-[10px]">{label}</span>
    </Badge>
  )
}
