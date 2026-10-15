"use client"

import { useTranslations } from "next-intl"
import { Bot, FolderGit2, Plug, RefreshCw, Server, TerminalSquare } from "lucide-react"
import { SettingsBlock } from "@/components/settings/common/settings-block"
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
 * connected OpenCode agents of either API version — the OpenCode analog of
 * {@link CodexAppServerStatusCard}, and the first UI consumer of
 * `openCodeServerExtension`.
 */
export function OpencodeStatusCard({ agentId, connected }: OpencodeStatusCardProps) {
  const t = useTranslations("externalAgent.settings.opencode")
  const { status, loading, available, refresh } = useOpencodeStatus(agentId, connected)

  const surfaceNotice = (surface: keyof NonNullable<typeof status.surfaces>) => {
    const state = status.surfaces?.[surface]
    if (!state || state === "ready") return null
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid={`opencode-${surface}-${state}`}
      >
        <p className="text-xs text-muted-foreground" role={state === "error" ? "alert" : "status"}>
          {t(
            state === "error"
              ? "loadFailed"
              : state === "unsupported"
                ? "unavailableForVersion"
                : "checking"
          )}
        </p>
        {state === "error" && (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            {t("retry")}
          </Button>
        )}
      </div>
    )
  }

  if (!connected || !available) {
    const failedSurface = connected
      ? (
          Object.keys(status.surfaces ?? {}) as Array<keyof NonNullable<typeof status.surfaces>>
        ).find((surface) => status.surfaces?.[surface] === "error")
      : undefined
    return (
      <SettingsBlock title={t("title")} headingLevel={4}>
        {failedSurface ? (
          surfaceNotice(failedSurface)
        ) : (
          <p className="text-xs text-muted-foreground">
            {t(connected && loading ? "checking" : "notConnected")}
          </p>
        )}
      </SettingsBlock>
    )
  }

  return (
    <SettingsBlock
      title={t("title")}
      headingLevel={4}
      testid="opencode-status"
      contentClassName="space-y-0 divide-y divide-border/60 [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0"
      action={
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
      }
    >
      {(status.project ||
        status.surfaces?.project === "error" ||
        status.surfaces?.project === "loading") && (
        <div className="space-y-1" data-testid="opencode-project">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FolderGit2 className="h-3.5 w-3.5" />
            {t("project")}
          </div>
          {surfaceNotice("project") ?? (
            <p className="break-all text-xs">
              {status.project?.worktree ?? "—"}
              {status.project?.vcs ? ` · ${status.project.vcs}` : ""}
            </p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Plug className="h-3.5 w-3.5" />
          {t("providers")}
        </div>
        {surfaceNotice("providerAuth")}
        {surfaceNotice("providers") ??
          (status.providers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noProviders")}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {status.providers.map((provider) => (
                <Badge
                  key={provider.id}
                  variant={provider.connected ? "default" : "outline"}
                  className="max-w-full whitespace-normal break-all text-[10px]"
                  data-testid="opencode-provider"
                  title={provider.connected === undefined ? t("providerAuthUnknown") : undefined}
                >
                  {provider.name ?? provider.id}
                </Badge>
              ))}
            </div>
          ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          {t("agents")}
        </div>
        {surfaceNotice("agents") ??
          (status.agents.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noAgents")}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {status.agents.map((agent) => (
                <Badge
                  key={agent.id}
                  variant="outline"
                  className="max-w-full whitespace-normal break-all text-[10px]"
                  data-testid="opencode-agent"
                >
                  {agent.name ?? agent.id}
                </Badge>
              ))}
            </div>
          ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <TerminalSquare className="h-3.5 w-3.5" />
          {t("commands")}
        </div>
        {surfaceNotice("commands") ??
          (status.commands.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noCommands")}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {status.commands.map((command) => (
                <Badge
                  key={command.name}
                  variant="outline"
                  className="max-w-full whitespace-normal break-all text-[10px]"
                  data-testid="opencode-command"
                >
                  /{command.name}
                </Badge>
              ))}
            </div>
          ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Server className="h-3.5 w-3.5" />
          {t("mcpServers")}
        </div>
        {surfaceNotice("mcp") ??
          (status.mcpServers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noMcpServers")}</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {status.mcpServers.map((server) => (
                <Badge
                  key={server.name}
                  variant="outline"
                  className="max-w-full whitespace-normal break-all text-[10px]"
                  data-testid="opencode-mcp-server"
                >
                  {server.name}
                  {server.status ? ` · ${server.status}` : ""}
                </Badge>
              ))}
            </div>
          ))}
      </div>

      {(status.lspServers.length > 0 ||
        (status.surfaces?.lsp && status.surfaces.lsp !== "ready")) && (
        <div className="space-y-1" data-testid="opencode-lsp">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            {t("lspServers")}
          </div>
          {surfaceNotice("lsp") ?? (
            <div className="flex flex-wrap gap-1">
              {status.lspServers.map((server) => (
                <Badge
                  key={server.id}
                  variant="outline"
                  className="max-w-full whitespace-normal break-all text-[10px]"
                >
                  {server.id}
                  {server.status ? ` · ${server.status}` : ""}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsBlock>
  )
}
