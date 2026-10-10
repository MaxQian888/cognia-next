"use client"

/**
 * Connectivity → Network drive → Live file access (ADR-0222 §7.5): every
 * network-drive share on this host, across conversations, with the same
 * controls the Files panel has, and the host-wide activity trail.
 */

import { useTranslations } from "next-intl"

import { LiveGrantsList } from "@/components/filespace/live-grants-list"
import { LiveShareAudit } from "@/components/filespace/live-share-audit"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import type { LiveFileShareState } from "@/hooks/filespace/use-live-file-share"
import type { Transport } from "@/lib/tauri/transport-types"
import type { FileShareStatus } from "@/types/filespace/live"

export interface LiveAccessBlockProps {
  live: LiveFileShareState
  status: FileShareStatus
  /** The host the panel drives; must be stable across renders. */
  transport: Transport
}

export function LiveAccessBlock({ live, status, transport }: LiveAccessBlockProps) {
  const t = useTranslations("liveShare")
  return (
    <>
      <SettingsBlock
        title={t("settings.access.title")}
        description={t("settings.access.description")}
        testid="live-access-block"
        badge={
          <span className="text-xs text-muted-foreground">
            {t("grants.stats", {
              grants: status.activeGrants,
              connections: status.liveConnections,
            })}
          </span>
        }
      >
        <LiveGrantsList
          grants={live.grants}
          status={status}
          transport={transport}
          showConversation
          onChanged={live.reload}
        />
      </SettingsBlock>
      <SettingsBlock
        title={t("audit.title")}
        description={t("audit.description")}
        testid="live-access-audit"
        collapsible
        defaultOpen={false}
      >
        <LiveShareAudit transport={transport} />
      </SettingsBlock>
    </>
  )
}
