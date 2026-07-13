"use client"

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CheckCircle2Icon,
  CopyIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  ScrollTextIcon,
  StarIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react"

import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { mcpServerLogsHref } from "@/hooks/mcp/use-mcp-server-logs"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"
import { testMcpServer, type McpTestResult } from "@/lib/claude/ipc"
import type { McpServer } from "@cognia/agent-config-types"
import { McpAgentChipGroup } from "../mcp-agent-chip-group"
import { McpAuthButton } from "./mcp-auth-button"
import { serverToTestRequest, summarizeServer } from "./mcp-server-utils"

export interface McpServerCardProps {
  server: McpServer
  selected: boolean
  favorite: boolean
  /** Dense list-row layout instead of the default card. */
  variant?: "card" | "row"
  onToggleSelect: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggle: (enabled: boolean) => void | Promise<void>
  onEdit: (id: string) => void
  onClone: (server: McpServer) => void
  onDelete: (server: McpServer) => void
}

/**
 * A single MCP server tile. Carries selection checkbox, favorite star, the
 * transport + last-test-result badges, the per-agent projection chips, and the
 * test / toggle / edit / clone / delete actions. `variant="row"` renders the
 * same content in a compact single-line layout for the list view.
 */
export function McpServerCard({
  server,
  selected,
  favorite,
  variant = "card",
  onToggleSelect,
  onToggleFavorite,
  onToggle,
  onEdit,
  onClone,
  onDelete,
}: McpServerCardProps) {
  const tRow = useTranslations("mcp.row")
  const tCard = useTranslations("mcp.card")
  const tTest = useTranslations("mcp.test")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)

  const runTest = async () => {
    if (testing) return
    if (!isTauri()) {
      toast.error(tTest("desktopOnly"))
      return
    }
    setTesting(true)
    try {
      loggers.mcp.info("settings.serverTestStarted", { id: server.id, transport: server.transport })
      const result = await testMcpServer(serverToTestRequest(server))
      setTestResult(result)
      loggers.mcp.info("settings.serverTestResult", {
        id: server.id,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      })
      if (result.ok) {
        toast.success(tTest("success", { name: server.name, count: result.toolCount }))
      } else {
        toast.error(
          tTest("error", { name: server.name, error: result.error ?? tTest("unknownError") })
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loggers.mcp.error("settings.serverTestThrew", err)
      setTestResult({ ok: false, toolCount: 0, tools: [], error: message, durationMs: 0 })
      toast.error(tTest("error", { name: server.name, error: message }))
    } finally {
      setTesting(false)
    }
  }

  const testBadge = testResult && (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
        testResult.ok
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-destructive/10 text-destructive"
      )}
      title={testResult.ok ? testResult.tools.map((tl) => tl.name).join(", ") : testResult.error}
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
  )

  const actions = (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5",
        // Reveal on hover at pointer-fine; always visible on touch.
        "sm:opacity-60 sm:transition-opacity sm:group-hover:opacity-100",
        "[@media(hover:none)]:opacity-100"
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7", favorite && "text-amber-500")}
        onClick={() => onToggleFavorite(server.id)}
        aria-label={
          favorite
            ? tCard("unfavorite", { name: server.name })
            : tCard("favorite", { name: server.name })
        }
        aria-pressed={favorite}
      >
        <StarIcon className={cn("size-3.5", favorite && "fill-current")} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void runTest()}
        disabled={testing || !isTauri()}
        aria-label={tRow("test", { name: server.name })}
        title={isTauri() ? tRow("testTooltip") : tRow("testDesktopOnly")}
      >
        {testing ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
      </Button>
      <Button asChild variant="ghost" size="icon" className="size-7" title={tRow("logsTooltip")}>
        <Link
          href={mcpServerLogsHref(server.name)}
          aria-label={tRow("logs", { name: server.name })}
        >
          <ScrollTextIcon className="size-3.5" />
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => onEdit(server.id)}
        aria-label={tRow("edit", { name: server.name })}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => onClone(server)}
        aria-label={tCard("clone", { name: server.name })}
      >
        <CopyIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive"
        onClick={() => onDelete(server)}
        aria-label={tRow("delete", { name: server.name })}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  )

  const selectBox = (
    <Checkbox
      checked={selected}
      onCheckedChange={() => onToggleSelect(server.id)}
      aria-label={tCard("selectAria", { name: server.name })}
      className="shrink-0"
    />
  )

  const toggle = (
    <Switch
      checked={server.enabled}
      onCheckedChange={(v) => void onToggle(v)}
      aria-label={
        server.enabled
          ? tRow("disableSwitch", { name: server.name })
          : tRow("enableSwitch", { name: server.name })
      }
    />
  )

  const transportBadge = (
    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
      {server.transport}
    </span>
  )

  if (variant === "row") {
    return (
      <div
        className={cn(
          "group flex items-center gap-2 rounded-md border bg-card px-2.5 py-2",
          !server.enabled && "opacity-70"
        )}
        data-testid="mcp-server-row"
      >
        {selectBox}
        <p className="truncate text-sm font-medium">{server.name}</p>
        {transportBadge}
        {testBadge}
        <span className="ml-1 hidden min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground md:inline">
          {summarizeServer(server)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {toggle}
          {actions}
        </div>
      </div>
    )
  }

  return (
    <Card
      className={cn(
        "group flex flex-col gap-2 p-3 transition-colors",
        selected && "border-primary/50 ring-1 ring-primary/30",
        !server.enabled && "opacity-70"
      )}
      data-testid="mcp-server-card"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {selectBox}
          <p className="truncate text-sm font-medium">{server.name}</p>
          {transportBadge}
          {testBadge}
        </div>
        <div className="flex shrink-0 items-center gap-1">{toggle}</div>
      </div>
      <p className="line-clamp-1 break-all font-mono text-[11px] text-muted-foreground">
        {summarizeServer(server)}
      </p>
      <div className="flex items-center justify-between gap-2">
        <McpAgentChipGroup server={server} />
        {actions}
      </div>
      <McpAuthButton server={server} />
    </Card>
  )
}
