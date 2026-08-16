"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowRightLeft, Undo2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  isLegacyPiAcpAgent,
  isMigratedPiAgent,
  migrateToPiRpc,
  rollbackPiRpcMigration,
  type PiMigrationBlocker,
} from "@/lib/ai/agent/external/pi-migration"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

export interface PiMigrationCardProps {
  agent: ExternalAgentConfig
  /** Blockers already evaluated by the caller (binary, version, sandbox). */
  blockers?: PiMigrationBlocker[]
  onApply: (next: ExternalAgentConfig) => void | Promise<void>
}

/**
 * Offers the one-way move from the community `pi-acp` ACP bridge to the native
 * `pi-rpc` adapter, and the way back.
 *
 * Renders nothing unless this specific agent is either the legacy bridge or an
 * already-migrated agent — every other agent in the list is untouched, which is
 * the point: ADR-0119 does not auto-rewrite anything.
 *
 * The session-continuity note is not decoration. An ACP session id does not map
 * onto a Pi session, so the first run after migrating starts a fresh native
 * session; users who expect their in-progress conversation to survive would
 * otherwise read that as data loss.
 */
export function PiMigrationCard({ agent, blockers = [], onApply }: PiMigrationCardProps) {
  const t = useTranslations("externalAgent.settings.piMigration")
  const [busy, setBusy] = useState(false)

  const legacy = isLegacyPiAcpAgent(agent)
  const migrated = isMigratedPiAgent(agent)
  if (!legacy && !migrated) return null

  const run = async (next: ExternalAgentConfig | null) => {
    if (!next) return
    setBusy(true)
    try {
      await onApply(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="pi-migration-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("title")}</p>
        <Badge variant={migrated ? "default" : "secondary"}>
          {migrated ? t("statusNative") : t("statusLegacy")}
        </Badge>
      </div>

      <p className="text-muted-foreground text-xs">
        {migrated ? t("migratedDescription") : t("legacyDescription")}
      </p>

      {legacy && blockers.length > 0 && (
        <ul className="space-y-1" data-testid="pi-migration-blockers">
          {blockers.map((blocker) => (
            <li key={blocker} className="text-destructive text-xs">
              {t(`blocker.${blocker}`)}
            </li>
          ))}
        </ul>
      )}

      {legacy && <p className="text-muted-foreground text-xs">{t("continuityNote")}</p>}

      {legacy ? (
        <Button
          size="sm"
          disabled={busy || blockers.length > 0}
          onClick={() => void run(migrateToPiRpc(agent).config)}
          data-testid="pi-migrate-button"
        >
          <ArrowRightLeft className="mr-2 size-3.5" />
          {t("migrateAction")}
        </Button>
      ) : (
        <div className="space-y-2">
          {/* Rollback restores the adapter config only: Pi session files and
              Cognia transcripts created while running natively are user data
              and are deliberately left in place. */}
          <p className="text-muted-foreground text-xs">{t("rollbackNote")}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(rollbackPiRpcMigration(agent))}
            data-testid="pi-rollback-button"
          >
            <Undo2 className="mr-2 size-3.5" />
            {t("rollbackAction")}
          </Button>
        </div>
      )}
    </div>
  )
}
