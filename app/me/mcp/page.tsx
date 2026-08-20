"use client"

/**
 * Mobile MCP servers page (ADR-0056, Wave 4).
 *
 * Mirrors the paired desktop's MCP servers (`mcpServerSummaries`, warmed by
 * the sync handler) and — new — writes two things back through the mobile
 * outbound queue: whether a server is on, and which of its tools are denied.
 *
 * Paired-only (`<PairedOnly>`, decision D2): the standalone (BYOK) webview
 * engine runs no MCP, so a server list there would be dead config.
 *
 * The write surface stops at those two axes on purpose. Creating, editing and
 * deleting a definition carries credentials and a trust decision, and the
 * OAuth flow needs the desktop keyring — none of that belongs on the wire, so
 * those stay "manage on desktop" rather than becoming a lesser copy here.
 *
 * Tool names come from the summary mirror (`toolNames`, projected on the
 * desktop after each discovery). A server the desktop has never probed shows
 * no tool list rather than an empty one, because "no tools" and "not yet
 * asked" are different answers.
 */

import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, MonitorSmartphoneIcon, ServerIcon } from "lucide-react"
import { toast } from "sonner"

import { MeSection } from "@/components/mobile/me/me-section"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import { isToolDenied, matchingToolPatterns, normalizeToolRuleList } from "@/lib/mcp/tool-rules"
import type { McpServerSummary } from "@cognia/agent-config-types"

function McpBody() {
  const t = useTranslations("mobile.mcp")
  const servers = useLiveQuery(async () => {
    // `displayName` is not an index on this table — read then sort in memory.
    const rows = await getDb().mcpServerSummaries.toArray()
    return rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [])

  // Optimistic local write first, then the durable queue row — same shape as
  // the plugins panel, so the switch settles immediately and the desktop
  // catches up when the queue drains.
  const onToggle = useCallback(
    async (server: McpServerSummary, enabled: boolean) => {
      try {
        await getDb().mcpServerSummaries.update(server.id, { enabled, updatedAt: Date.now() })
        await enqueue({
          command: "mcp_set_enabled",
          payload: { id: server.id, enabled },
          label: t("queueToggleLabel", {
            name: server.displayName,
            state: enabled ? t("enabled") : t("disabled"),
          }),
        })
      } catch (err) {
        toast.error(t("writeFailed", { message: err instanceof Error ? err.message : String(err) }))
      }
    },
    [t]
  )

  const onSetToolAllowed = useCallback(
    async (server: McpServerSummary, tool: string, allowed: boolean) => {
      const current = normalizeToolRuleList(server.disallowedTools)
      const next = allowed ? current.filter((name) => name !== tool) : [...current, tool]
      const disallowedTools = normalizeToolRuleList(next)
      try {
        await getDb().mcpServerSummaries.update(server.id, {
          disallowedTools,
          updatedAt: Date.now(),
        })
        await enqueue({
          command: "mcp_set_tool_rules",
          payload: { id: server.id, disallowedTools },
          label: t("queueToolLabel", { name: server.displayName, tool }),
        })
      } catch (err) {
        toast.error(t("writeFailed", { message: err instanceof Error ? err.message : String(err) }))
      }
    },
    [t]
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="mcp-intro">
        {t("intro")}
      </p>

      {servers && servers.length > 0 ? (
        <MeSection title={t("sectionTitle")} testid="me-section-mcp">
          {servers.map((server: McpServerSummary) => (
            <McpServerRow
              key={server.id}
              server={server}
              onToggle={onToggle}
              onSetToolAllowed={onSetToolAllowed}
            />
          ))}
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

function McpServerRow({
  server,
  onToggle,
  onSetToolAllowed,
}: {
  server: McpServerSummary
  onToggle: (server: McpServerSummary, enabled: boolean) => void | Promise<void>
  onSetToolAllowed: (
    server: McpServerSummary,
    tool: string,
    allowed: boolean
  ) => void | Promise<void>
}) {
  const t = useTranslations("mobile.mcp")
  const [open, setOpen] = useState(false)
  const remote = server.transport !== "stdio"
  const tools = server.toolNames ?? []
  const deniedCount = tools.filter((tool) => isToolDenied(tool, server)).length

  return (
    <div className="py-1" data-testid={`mcp-row-${server.id}`}>
      <Item size="sm" className="px-0">
        <ItemMedia>
          <ServerIcon className="size-4 text-muted-foreground" aria-hidden />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="text-xs">{server.displayName}</ItemTitle>
          <ItemDescription className="text-[11px]">
            <span className="font-mono">{server.transport}</span>
            {tools.length > 0 ? (
              <>
                {" · "}
                {deniedCount > 0
                  ? t("toolsWithDenied", { total: tools.length, denied: deniedCount })
                  : t("toolsCount", { count: tools.length })}
              </>
            ) : null}
            {remote ? <> · {t("remoteAuthNote")}</> : null}
          </ItemDescription>
        </ItemContent>
        <Badge
          variant={server.enabled ? "default" : "outline"}
          data-testid={`mcp-state-${server.id}`}
        >
          {server.enabled ? t("enabled") : t("disabled")}
        </Badge>
        <Switch
          checked={server.enabled}
          onCheckedChange={(value) => void onToggle(server, value)}
          aria-label={
            server.enabled
              ? t("disableAria", { name: server.displayName })
              : t("enableAria", { name: server.displayName })
          }
        />
      </Item>

      {tools.length > 0 ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-between px-1 text-[11px] text-muted-foreground"
              data-testid={`mcp-tools-toggle-${server.id}`}
            >
              {t("toolsSectionTitle")}
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", open && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="space-y-1 pb-1 pl-1" data-testid={`mcp-tools-${server.id}`}>
              {tools.map((tool) => {
                const matched = matchingToolPatterns(tool, server)
                const denied = isToolDenied(tool, server)
                return (
                  <li key={tool} className="flex items-center gap-2">
                    <Switch
                      checked={!denied}
                      disabled={matched.length > 0}
                      onCheckedChange={(value) => void onSetToolAllowed(server, tool, value)}
                      aria-label={
                        denied
                          ? t("allowToolAria", { name: tool })
                          : t("denyToolAria", { name: tool })
                      }
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-[11px]",
                        denied && "text-muted-foreground line-through"
                      )}
                    >
                      {tool}
                    </span>
                    {matched.length > 0 ? (
                      <Badge variant="outline" className="shrink-0 text-[9px]">
                        {t("deniedByPattern", { pattern: matched[0] })}
                      </Badge>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            <p className="pb-2 pl-1 text-[10px] text-muted-foreground">{t("rulesOnDesktop")}</p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
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
