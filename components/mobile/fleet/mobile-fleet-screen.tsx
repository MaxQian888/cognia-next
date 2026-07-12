"use client"

/**
 * Mobile Agent-Fleet screen — mirrors the desktop island's triage read for a
 * phone / companion-connected browser. Pulls the snapshot through
 * `useFleetSnapshot` (transport-backed off Tauri), sorts it with the shared
 * `sortForIsland`, and renders theme-aware `<MobileFleetRow>`s. A parked
 * permission can be answered remotely; view is fully reliable, remote approve
 * is best-effort (bounded by the desktop's answer window).
 */

import { useTranslations } from "next-intl"

import { MobileFleetRow } from "./mobile-fleet-row"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { fleetStatusSummary, sortForIsland } from "@/lib/fleet/format"

export function MobileFleetScreen() {
  const t = useTranslations("mobile.fleet")
  const { snapshot, source } = useFleetSnapshot()

  if (source === "none") {
    return (
      <p className="p-4 text-xs text-muted-foreground" data-testid="mobile-fleet-connect">
        {t("connectFirst")}
      </p>
    )
  }

  const sessions = sortForIsland(snapshot.sessions)
  const summary = fleetStatusSummary(sessions)

  return (
    <div className="flex h-full flex-col" data-testid="mobile-fleet-screen">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h1 className="text-sm font-semibold">{t("title")}</h1>
        {summary.total > 0 ? (
          <span className="text-[11px] text-muted-foreground" data-testid="mobile-fleet-summary">
            {t("summary", { total: summary.total })}
            {summary.attention > 0 ? ` · ${t("waiting", { count: summary.attention })}` : ""}
          </span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground" data-testid="mobile-fleet-empty">
            {t("empty")}
          </p>
        ) : (
          <div className="space-y-2 p-3" data-testid="mobile-fleet-list">
            {sessions.map((s) => (
              <MobileFleetRow key={`${s.agent}:${s.sessionId}`} session={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default MobileFleetScreen
