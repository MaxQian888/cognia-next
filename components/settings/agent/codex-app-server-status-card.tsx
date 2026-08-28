"use client"

import { useTranslations, useFormatter } from "next-intl"
import { Gauge, RefreshCw, Server, ShieldCheck, Sparkles, UserRound } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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
  const format = useFormatter()
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

      {/* Account (from account/read + account/updated) */}
      {(status.account !== undefined || status.requiresOpenaiAuth) && (
        <div className="space-y-1" data-testid="codex-account-section">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <UserRound className="h-3.5 w-3.5" />
            {t("account")}
          </div>
          {status.account ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span data-testid="codex-account-email">
                {status.account.email ?? status.account.type ?? "—"}
              </span>
              {status.account.planType && (
                <Badge variant="outline" className="text-[10px]" data-testid="codex-account-plan">
                  {status.account.planType}
                </Badge>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="codex-account-signin">
              {t("signInRequired")}
            </p>
          )}
        </div>
      )}

      {/* Rate limits (from account/rateLimits/read + account/rateLimits/updated) */}
      {status.rateLimits?.primary && (
        <div className="space-y-1" data-testid="codex-rate-limits">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Gauge className="h-3.5 w-3.5" />
            {t("usage")}
          </div>
          <div className="flex items-center gap-2">
            <Progress
              value={Math.min(100, Math.max(0, status.rateLimits.primary.usedPercent))}
              className="h-1.5 flex-1"
            />
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("usedPercent", { percent: status.rateLimits.primary.usedPercent })}
            </span>
          </div>
          {typeof status.rateLimits.primary.resetsAt === "number" && (
            <p className="text-xs text-muted-foreground" data-testid="codex-rate-limit-reset">
              {t("resetsAt", {
                time: format.dateTime(new Date(status.rateLimits.primary.resetsAt * 1000), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </p>
          )}
          {status.rateLimits.rateLimitReachedType && (
            <Badge variant="destructive" className="text-[10px]" data-testid="codex-rate-limited">
              {t("rateLimitReached")}
            </Badge>
          )}
        </div>
      )}

      {/* Managed/enterprise limits (configRequirements/read). Cognia refuses a
          request these forbid before sending it, because Codex has no typed
          refusal error to recognise afterwards. */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          {t("managedPolicy")}
        </div>
        {status.configRequirementsUnsupported ? (
          // Inert on purpose, and labelled so: this Codex cannot be asked, which
          // is not the same claim as "this Codex restricts nothing".
          <p className="text-xs text-muted-foreground" data-testid="codex-requirements-unsupported">
            {t("managedPolicyUnsupported")}
          </p>
        ) : !status.configRequirements ? (
          <p className="text-xs text-muted-foreground">{t("managedPolicyNone")}</p>
        ) : (
          <div className="flex flex-wrap gap-1" data-testid="codex-managed-policy">
            {status.configRequirements.allowedSandboxModes?.map((mode) => (
              <Badge key={`sandbox-${mode}`} variant="outline" className="text-[10px]">
                {t("managedPolicySandbox", { value: mode })}
              </Badge>
            ))}
            {status.configRequirements.allowedApprovalPolicies?.map((policy) => (
              <Badge key={`approval-${policy}`} variant="outline" className="text-[10px]">
                {t("managedPolicyApproval", { value: policy })}
              </Badge>
            ))}
            {Object.entries(status.configRequirements.allowedPermissionProfiles ?? {})
              .filter(([, allowed]) => allowed)
              .map(([id]) => (
                <Badge key={`profile-${id}`} variant="outline" className="text-[10px]">
                  {t("managedPolicyProfile", { value: id })}
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
