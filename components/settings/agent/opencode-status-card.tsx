"use client"

import { useTranslations } from "next-intl"
import { Bot, FolderGit2, Plug, RefreshCw, Server, TerminalSquare } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useOpencodeStatus } from "@/hooks/agent/use-opencode-status"

interface OpencodeStatusCardProps {
  agentId: string
  connected: boolean
}

/**
 * Compact, read-only surface for a connected OpenCode server: the current
 * project, providers (connected ones highlighted), agents, slash commands, and
 * MCP/LSP server state. Rendered inside an agent's detail panel only for
 * connected `opencode` agents — the OpenCode analog of
 * {@link CodexAppServerStatusCard}, and the first UI consumer of
 * `getOpenCodeAdapter()`.
 */
export function OpencodeStatusCard({ agentId, connected }: OpencodeStatusCardProps) {
  const t = useTranslations("externalAgent.settings.opencode")
  const { status, loading, available, refresh } = useOpencodeStatus(agentId, connected)

  if (!connected || !available) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t("notConnected")}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="opencode-status">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("title")}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="opencode-status-refresh"
          aria-label={t("refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {status.project && (status.project.worktree || status.project.vcs) && (
        <div className="space-y-1" data-testid="opencode-project">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FolderGit2 className="h-3.5 w-3.5" />
            {t("project")}
          </div>
          <p className="break-all text-xs">
            {status.project.worktree ?? "—"}
            {status.project.vcs ? ` · ${status.project.vcs}` : ""}
          </p>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Plug className="h-3.5 w-3.5" />
          {t("providers")}
        </div>
        {status.providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noProviders")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {status.providers.map((provider) => (
              <Badge
                key={provider.id}
                variant={provider.connected ? "default" : "outline"}
                className="text-[10px]"
                data-testid="opencode-provider"
              >
                {provider.name ?? provider.id}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          {t("agents")}
        </div>
        {status.agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noAgents")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {status.agents.map((agent) => (
              <Badge
                key={agent.id}
                variant="outline"
                className="text-[10px]"
                data-testid="opencode-agent"
              >
                {agent.name ?? agent.id}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <TerminalSquare className="h-3.5 w-3.5" />
          {t("commands")}
        </div>
        {status.commands.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noCommands")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {status.commands.map((command) => (
              <Badge
                key={command.name}
                variant="outline"
                className="text-[10px]"
                data-testid="opencode-command"
              >
                /{command.name}
              </Badge>
            ))}
          </div>
        )}
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
            {status.mcpServers.map((server) => (
              <Badge
                key={server.name}
                variant="outline"
                className="text-[10px]"
                data-testid="opencode-mcp-server"
              >
                {server.name}
                {server.status ? ` · ${server.status}` : ""}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {status.lspServers.length > 0 && (
        <div className="space-y-1" data-testid="opencode-lsp">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            {t("lspServers")}
          </div>
          <div className="flex flex-wrap gap-1">
            {status.lspServers.map((server) => (
              <Badge key={server.id} variant="outline" className="text-[10px]">
                {server.id}
                {server.status ? ` · ${server.status}` : ""}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
