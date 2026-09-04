"use client"

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CheckCircle2Icon,
  CopyIcon,
  PencilIcon,
  PlayIcon,
  ScrollTextIcon,
  ServerIcon,
  ShareIcon,
  ShieldCheckIcon,
  StarIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import { loggers } from "@cognia/logging"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { discoverMcpServerViaSidecar, type McpDiscoveryResult } from "@/lib/claude/feature-call"
import { recordMcpCapabilities } from "@/lib/mcp/runtime-gateway"
import { reviewMcpServer } from "@/lib/db/mcp-servers"
import { buildMcpInstallCommand, buildMcpTransferJson } from "@/lib/mcp/config-transfer"
import { mcpServerLogsHref, useMcpServerLogs } from "@/hooks/mcp/use-mcp-server-logs"
import type { AgentStatus } from "@/hooks/agent/use-agent-status"
import type { McpServer } from "@cognia/agent-config-types"
import { McpAgentChipGroup } from "../mcp-agent-chip-group"
import { McpAuthButton } from "./mcp-auth-button"
import { McpToolRulesCard } from "./mcp-tool-rules-card"
import { summarizeServer } from "./mcp-server-utils"

interface Props {
  server: McpServer
  favorite: boolean
  agentStatuses: AgentStatus[]
  agentStatusesLoading: boolean
  onToggle: (server: McpServer, enabled: boolean) => void | Promise<void>
  onToggleFavorite: (id: string) => void
  onEdit: (id: string) => void
  onClone: (server: McpServer) => void
  onExport: (server: McpServer) => void
  onDelete: (server: McpServer) => void
}

const TRUST_BADGE: Record<string, string> = {
  trusted: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "bg-destructive/10 text-destructive",
  legacy: "bg-muted text-muted-foreground",
}

/**
 * The detail half of the master-detail layout: everything about ONE server
 * that used to be crammed into a card or a modal — connection shape, per-tool
 * deny rules, which agent files it is projected into, OAuth state, and its
 * most recent log lines.
 *
 * The config FORM stays in the editor sheet. This pane is for reading state
 * and operating on it; mixing a validating form into a live-updating pane is
 * how the old surface ended up re-seeding fields under the user's cursor.
 */
export function McpServerDetail({
  server,
  favorite,
  agentStatuses,
  agentStatusesLoading,
  onToggle,
  onToggleFavorite,
  onEdit,
  onClone,
  onExport,
  onDelete,
}: Props) {
  const t = useTranslations("mcp.detail")
  const tRow = useTranslations("mcp.row")
  const tCard = useTranslations("mcp.card")
  const tTest = useTranslations("mcp.test")
  const tReach = useTranslations("surfaceReach")
  const [testing, setTesting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [testResult, setTestResult] = useState<McpDiscoveryResult | null>(null)
  const { logs } = useMcpServerLogs(server.name, { limit: 8 })

  /**
   * Discovery runs `claude_feature_call`, which is `transports: ["internal"]`,
   * so the gate itself is right. Its wording was not: "requires desktop mode"
   * is a platform claim, and a phone paired to a Host is not a browser that
   * needs a different build. `needs-desktop-shell` names the actual reason and
   * reuses the vocabulary every other gated surface already reads from.
   */
  const testReach = useSurfaceReach({ capability: "sidecar", requirement: "desktop-shell" })
  const label = server.displayName?.trim() || server.name
  const trustState = server.trust?.state ?? "legacy"
  const config = server.config as Record<string, unknown>

  const runTest = async () => {
    if (testing) return
    if (!testReach.available) {
      toast.error(tReach(`block.${testReach.block}`))
      return
    }
    setTesting(true)
    try {
      const result = await discoverMcpServerViaSidecar(server)
      setTestResult(result)
      if (result.ok) {
        // Feed the same cache the tool switches read, so a successful test
        // immediately populates the tool list instead of being thrown away.
        await recordMcpCapabilities(server, {
          tools: result.tools,
          resources: result.resources,
          prompts: result.prompts,
        })
        toast.success(tTest("success", { name: label, count: result.toolCount }))
      } else {
        toast.error(tTest("error", { name: label, error: result.error ?? tTest("unknownError") }))
      }
      loggers.mcp.info("settings.serverTestResult", { id: server.id, ok: result.ok })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loggers.mcp.error("settings.serverTestThrew", err)
      toast.error(tTest("error", { name: label, error: message }))
    } finally {
      setTesting(false)
    }
  }

  const copy = async (value: string, message: string) => {
    try {
      await writeClipboardText(value)
      toast.success(message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mcp-server-detail">
      <div className="flex shrink-0 flex-wrap items-start gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/50">
            <ServerIcon className="size-4 text-muted-foreground" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <h2 className="truncate text-sm font-semibold">{label}</h2>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                {server.transport}
              </span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] uppercase",
                  TRUST_BADGE[trustState]
                )}
              >
                {tCard(`trust.${trustState}`)}
              </span>
              {testResult && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
                    testResult.ok
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "bg-destructive/10 text-destructive"
                  )}
                >
                  {testResult.ok ? (
                    <>
                      <CheckCircle2Icon className="size-3" />
                      {testResult.toolCount === 1
                        ? tRow("toolsOne", { count: testResult.toolCount })
                        : tRow("toolsOther", { count: testResult.toolCount })}
                    </>
                  ) : (
                    <>
                      <XCircleIcon className="size-3" />
                      {tRow("failed")}
                    </>
                  )}
                </span>
              )}
            </div>
            {server.displayName?.trim() && server.displayName.trim() !== server.name && (
              <p className="truncate font-mono text-[10px] text-muted-foreground">{server.name}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={server.enabled}
            onCheckedChange={(value) => void onToggle(server, value)}
            aria-label={
              server.enabled
                ? tRow("disableSwitch", { name: label })
                : tRow("enableSwitch", { name: label })
            }
          />
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-7", favorite && "text-amber-500")}
            onClick={() => onToggleFavorite(server.id)}
            aria-pressed={favorite}
            aria-label={
              favorite ? tCard("unfavorite", { name: label }) : tCard("favorite", { name: label })
            }
          >
            <StarIcon className={cn("size-3.5", favorite && "fill-current")} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runTest()}
            disabled={testing || !testReach.available}
            title={testReach.available ? tRow("testTooltip") : tReach(`block.${testReach.block}`)}
          >
            {testing ? (
              <Spinner className="size-3.5 sm:mr-1.5" />
            ) : (
              <PlayIcon className="size-3.5 sm:mr-1.5" />
            )}
            <span className="hidden sm:inline">{t("test")}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => onEdit(server.id)}>
            <PencilIcon className="size-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">{t("edit")}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onExport(server)}
            aria-label={tRow("export", { name: label })}
          >
            <ShareIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onClone(server)}
            aria-label={tCard("clone", { name: label })}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-7"
            title={tRow("logsTooltip")}
          >
            <Link href={mcpServerLogsHref(server.name)} aria-label={tRow("logs", { name: label })}>
              <ScrollTextIcon className="size-3.5" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(server)}
            aria-label={tRow("delete", { name: label })}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {(trustState === "pending" || trustState === "legacy") && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-medium">{t("reviewTitle")}</p>
                <p className="text-[11px] text-muted-foreground">{t("reviewBody")}</p>
              </div>
              <Button
                size="sm"
                disabled={reviewing}
                onClick={async () => {
                  setReviewing(true)
                  try {
                    await reviewMcpServer(server.id, true)
                    toast.success(tCard("reviewed", { name: label }))
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err))
                  } finally {
                    setReviewing(false)
                  }
                }}
              >
                {reviewing ? (
                  <Spinner className="size-3.5 sm:mr-1.5" />
                ) : (
                  <ShieldCheckIcon className="size-3.5 sm:mr-1.5" />
                )}
                {tCard("reviewTrust")}
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <CardTitle className="text-sm">{t("connectionTitle")}</CardTitle>
                <CardDescription className="text-xs">{t("connectionSubtitle")}</CardDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() =>
                    void copy(
                      buildMcpTransferJson([
                        { name: server.name, transport: server.transport, config },
                      ]),
                      t("copiedJson")
                    )
                  }
                >
                  {t("copyJson")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() =>
                    void copy(
                      buildMcpInstallCommand(
                        { name: server.name, transport: server.transport, config },
                        "claude-code"
                      ),
                      t("copiedCommand")
                    )
                  }
                >
                  {t("copyCommand")}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="overflow-x-auto rounded-md bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed">
              {summarizeServer(server) || t("nothingConfigured")}
            </pre>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <MetaEntry label={t("metaOrigin")} value={server.origin ?? "manual"} />
              <MetaEntry label={t("metaRevision")} value={String(server.revision ?? 1)} />
              <MetaEntry
                label={t("metaEnv")}
                value={String(Object.keys((config.env ?? config.headers ?? {}) as object).length)}
              />
              <MetaEntry
                label={t("metaUpdated")}
                value={new Date(server.updatedAt).toLocaleDateString()}
              />
            </dl>
            <McpAuthButton server={server} />
          </CardContent>
        </Card>

        <McpToolRulesCard server={server} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{t("agentsTitle")}</CardTitle>
            <CardDescription className="text-xs">{t("agentsSubtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <McpAgentChipGroup
              server={server}
              statuses={agentStatuses}
              loading={agentStatusesLoading}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <CardTitle className="text-sm">{t("logsTitle")}</CardTitle>
                <CardDescription className="text-xs">{t("logsSubtitle")}</CardDescription>
              </div>
              <Button asChild variant="outline" size="sm" className="h-7 shrink-0 text-[11px]">
                <Link href={mcpServerLogsHref(server.name)}>{t("openLogs")}</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("logsEmpty")}</p>
            ) : (
              <ul className="space-y-1">
                {logs.slice(0, 8).map((entry, index) => (
                  <li
                    key={`${entry.timestamp}-${index}`}
                    className="flex items-baseline gap-2 text-[11px]"
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-4 shrink-0 px-1 text-[9px] uppercase",
                        (entry.level === "error" || entry.level === "fatal") &&
                          "border-destructive/40 text-destructive"
                      )}
                    >
                      {entry.level}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate" title={entry.message}>
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function MetaEntry({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-mono">{value}</dd>
    </div>
  )
}
