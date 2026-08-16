"use client"

/**
 * Mobile MCP servers page (ADR-0056, Wave 4). Read-only viewer of the paired
 * desktop's configured MCP servers (name / transport / enabled state),
 * mirrored into Dexie by the `mcpServers` sync handler.
 *
 * Paired-only (`<PairedOnly>`, decision D2): the standalone (BYOK) webview
 * engine runs no MCP, so a server list there would be dead config. MCP only
 * has a real backend on a paired desktop.
 *
 * Read-only (decision D6): there is no `mcp_set_enabled` companion push RPC,
 * and inventing one is out of scope — so enable/disable, create, edit and the
 * OAuth authenticate flow (desktop-only, `isTauri()` + `mcpOAuthAuthenticate`)
 * are all "manage on desktop". Remote (sse/http) servers surface an
 * "authenticate on desktop" note instead of the desktop auth action.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon, ServerIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { getDb } from "@/lib/db/schema"
import type { McpServerSummary } from "@cognia/agent-config-types"

function McpBody() {
  const t = useTranslations("mobile.mcp")
  const servers = useLiveQuery(async () => {
    const rows = await getDb().mcpServerSummaries.toArray()
    return rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="mcp-intro">
        {t("intro")}
      </p>

      {servers && servers.length > 0 ? (
        <MeSection title={t("sectionTitle")} testid="me-section-mcp">
          {servers.map((server: McpServerSummary) => {
            const remote = server.transport !== "stdio"
            return (
              <Item key={server.id} size="sm" className="px-0" data-testid={`mcp-row-${server.id}`}>
                <ItemMedia>
                  <ServerIcon className="size-4 text-muted-foreground" aria-hidden />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-xs">{server.displayName}</ItemTitle>
                  <ItemDescription className="text-[11px]">
                    <span className="font-mono">{server.transport}</span>
                    {remote ? <> · {t("remoteAuthNote")}</> : null}
                  </ItemDescription>
                </ItemContent>
                <Badge
                  variant={server.enabled ? "default" : "outline"}
                  data-testid={`mcp-state-${server.id}`}
                >
                  {server.enabled ? t("enabled") : t("disabled")}
                </Badge>
              </Item>
            )
          })}
        </MeSection>
      ) : (
        <MeSection title={t("sectionTitle")} testid="me-section-mcp">
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemDescription className="text-xs" data-testid="mcp-empty">
                {t("empty")}
              </ItemDescription>
            </ItemContent>
          </Item>
        </MeSection>
      )}

      <div
        className="flex items-start gap-3 rounded-xl border bg-card px-3 py-3 text-xs text-muted-foreground"
        data-testid="mcp-manage-note"
      >
        <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t("manageOnDesktop")}</p>
      </div>
    </div>
  )
}

export default function MobileMcpPage() {
  const t = useTranslations("mobile.mcp")
  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-mcp-page">
      <PairedOnly>
        <McpBody />
      </PairedOnly>
    </SubPageShell>
  )
}
