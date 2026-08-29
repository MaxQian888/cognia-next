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

  // Flattened first so "the policy permits nothing" is a state the render can
  // branch on. Counting the badges after emitting them cannot distinguish an
  // empty row from an absent one, and the empty row is the fail-closed case.
  const requirements = status.configRequirements
  const managedPolicyBadges: { key: string; label: string }[] = [
    ...(requirements?.allowedSandboxModes ?? []).map((mode) => ({
      key: `sandbox-${mode}`,
      label: t("managedPolicySandbox", { value: mode }),
    })),
    ...(requirements?.allowedApprovalPolicies ?? []).map((policy) => ({
      key: `approval-${policy}`,
      label: t("managedPolicyApproval", { value: policy }),
    })),
    ...Object.entries(requirements?.allowedPermissionProfiles ?? {})
      .filter(([, allowed]) => allowed)
      .map(([id]) => ({ key: `profile-${id}`, label: t("managedPolicyProfile", { value: id }) })),
  ]

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
        ) : status.configRequirements === undefined ? (
          // `undefined` is "not read": either the connect-time read has not
          // landed yet, or it threw and `refreshConfigRequirements` logged and
          // moved on. Both used to fall through to "declares no managed limits",
          // which is the one claim this card exists not to make on a Codex
          // nobody has actually asked.
          <p className="text-xs text-muted-foreground" data-testid="codex-requirements-unread">
            {t("managedPolicyUnread")}
          </p>
        ) : status.configRequirements === null ? (
          <p className="text-xs text-muted-foreground">{t("managedPolicyNone")}</p>
        ) : managedPolicyBadges.length === 0 ? (
          // A requirements object whose every allowlist is empty is the
          // fail-closed extreme: nothing is permitted, so every request is
          // refused before it is sent. Rendering an empty badge row for that
          // read on screen as "unrestricted" — the exact opposite.
          <p className="text-xs text-muted-foreground" data-testid="codex-managed-policy-empty">
            {t("managedPolicyForbidsAll")}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1" data-testid="codex-managed-policy">
            {managedPolicyBadges.map(({ key, label }) => (
              <Badge key={key} variant="outline" className="text-[10px]">
                {label}
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
