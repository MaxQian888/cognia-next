"use client"

// Backend-runtime status card. Shows which storage backend is active
// (web-dexie / desktop-dexie) plus a per-domain "mirrored" matrix. Adapted
// from D:\Project\Cognia\components\settings\data\local-persistence-visibility-panel.tsx.
// Cognia models a Dexie+SQLite duality with reconciliation; cognia-next is
// Dexie-only, so the projection we build here is a stub that just reports
// the active backend.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { isTauri } from "@/lib/tauri"
import type { LocalPersistenceVisibilityProjection } from "@/lib/storage"

interface LocalPersistenceVisibilityPanelProps {
  projection?: LocalPersistenceVisibilityProjection
  className?: string
}

export function LocalPersistenceVisibilityPanel({
  projection,
  className,
}: LocalPersistenceVisibilityPanelProps) {
  const t = useTranslations("settings.data.backendReadiness")
  const computed = useDefaultProjection()
  const data = projection ?? computed
  if (!data) return null

  return (
    <div className={className} data-testid="local-persistence-visibility">
      <div className="space-y-1">
        <p className="text-xs font-medium">{t("title")}</p>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      </div>

      <div className="mt-3 rounded-md border border-border/60 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{data.modeLabel}</span>
          <Badge variant={data.isDegraded ? "destructive" : "outline"}>
            {data.activeBackendLabel}
          </Badge>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">{data.summary}</p>
        {data.diagnosticMessages.map((message) => (
          <p key={message} className="mt-1 text-[10px] text-muted-foreground">
            {message}
          </p>
        ))}
      </div>

      <div className="mt-3 space-y-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("mirroredDomains")}
        </p>
        <div className="flex flex-wrap gap-2">
          {data.mirroredDomains.map((domain) => (
            <Badge key={domain.id} variant={toBadgeVariant(domain.status)}>
              {domain.label}: {t(`status.${domain.status}` as never)}
            </Badge>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">{data.reconciliationLabel}</p>
      </div>

      {data.recovery && (
        <div className="mt-3 rounded-md border border-border/60 px-3 py-2 text-xs">
          <p className="font-medium">{data.recovery.headline}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{data.recovery.detail}</p>
          {data.recovery.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-[10px] text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function toBadgeVariant(
  status: "completed" | "pending" | "degraded" | "unavailable"
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default"
  if (status === "pending") return "secondary"
  if (status === "degraded") return "destructive"
  return "outline"
}

/** Build a default projection that reflects cognia-next's actual setup
 *  (Dexie everywhere). Surfaces the current runtime so users at least see
 *  whether they're in the desktop shell or the browser. */
function useDefaultProjection(): LocalPersistenceVisibilityProjection {
  const t = useTranslations("settings.data.backendReadiness")
  return useMemo<LocalPersistenceVisibilityProjection>(() => {
    const tauri = isTauri()
    const activeBackendLabel = tauri ? "desktop-dexie" : "web-dexie"
    const modeLabel = tauri ? t("runtimeMode.desktop") : t("runtimeMode.web")
    const summary = tauri ? t("summary.tauri") : t("summary.web")
    return {
      modeLabel,
      activeBackendLabel,
      isDegraded: false,
      summary,
      diagnosticMessages: [],
      mirroredDomains: [
        { id: "chat", label: t("domains.chat"), status: "completed" },
        { id: "settings", label: t("domains.settings"), status: "completed" },
        { id: "skills", label: t("domains.skills"), status: "completed" },
        { id: "canvas", label: t("domains.canvas"), status: "completed" },
      ],
      reconciliationLabel: t("noMirroring"),
      recovery: null,
    }
  }, [t])
}
