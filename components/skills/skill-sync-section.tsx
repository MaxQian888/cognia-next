"use client"

import { useTranslations } from "next-intl"
import { RefreshCwIcon, AlertCircleIcon, CheckCircle2Icon, CircleDashedIcon } from "lucide-react"
import { useSkillSync } from "@/hooks/skills"
import { isTauri } from "@/lib/tauri"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
      <Alert data-testid="skill-sync-section" className="rounded-none border-x-0">
        <AlertDescription className="text-xs">{t("desktopOnly")}</AlertDescription>
      </Alert>
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
    <section data-testid="skill-sync-section" className="border-y py-3">
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
    </section>
  )
}

function StatusPill({ status, label }: { status: SyncStatus; label: string }) {
  const map = {
    synced: { icon: CheckCircle2Icon, variant: "secondary" as const },
    outOfSync: { icon: RefreshCwIcon, variant: "outline" as const },
    error: { icon: AlertCircleIcon, variant: "destructive" as const },
    never: { icon: CircleDashedIcon, variant: "outline" as const },
  }[status]
  const Icon = map.icon
  return (
    <Badge variant={map.variant} className="gap-1">
      <Icon className="size-3" />
      <span className="text-[10px]">{label}</span>
    </Badge>
  )
}
