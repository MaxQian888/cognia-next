"use client"

import { useTranslations } from "next-intl"
import { RefreshCw, Server, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCodexAppServerStatus } from "@/hooks/agent/use-codex-app-server-status"

interface CodexAppServerStatusCardProps {
  agentId: string
  connected: boolean
}

/**
 * Compact, read-only surface for the native Codex `app-server` runtime: the MCP
 * servers Codex has configured (from `~/.codex/config.toml`) and the skills it
 * discovered. Rendered inside an agent's detail panel only for connected
 * `codex-app-server` agents.
 */
export function CodexAppServerStatusCard({ agentId, connected }: CodexAppServerStatusCardProps) {
  const t = useTranslations("externalAgent.settings.codexAppServer")
  const { status, loading, available, refresh } = useCodexAppServerStatus(agentId, connected)

  if (!connected || !available) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t("notConnected")}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="codex-app-server-status">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("title")}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="codex-app-server-refresh"
          aria-label={t("refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Server className="h-3.5 w-3.5" />
          {t("mcpServers")}
        </div>
        {status.mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noMcpServers")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {status.mcpServers.map((server, i) => (
              <Badge
                key={server.name ?? i}
                variant="outline"
                className="text-[10px]"
                data-testid="codex-mcp-server"
              >
                {server.name ?? "—"}
                {server.status ? ` · ${server.status}` : ""}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          {t("skills")}
        </div>
        {status.skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noSkills")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {status.skills.map((skill, i) => (
              <Badge
                key={skill.path ?? skill.name ?? i}
                variant={skill.enabled === false ? "secondary" : "outline"}
                className="text-[10px]"
                data-testid="codex-skill"
              >
                {skill.name ?? skill.path ?? "—"}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
