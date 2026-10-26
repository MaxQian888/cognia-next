"use client"

import { useTranslations, useFormatter } from "next-intl"
import { Gauge, RefreshCw, Server, ShieldCheck, Sparkles, UserRound } from "lucide-react"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { useCodexAppServerStatus } from "@/hooks/agent/use-codex-app-server-status"

interface CodexAppServerStatusCardProps {
  agentId: string
  connected: boolean
}

const STATUS_ROW_CLASS_NAME =
  "grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0 @sm/codex-status:grid-cols-[8rem_minmax(0,1fr)] @sm/codex-status:gap-3"

/**
 * Compact, read-only surface for the native Codex `app-server` runtime: the MCP
 * servers Codex has configured (from `~/.codex/config.toml`) and the skills it
 * discovered. Disconnected agents show only a heading and an inline hint;
 * connected agents expose aligned status rows and a manual refresh.
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
      <SettingsBlock
        title={t("title")}
        headingLevel={4}
        badge={
          <span className="text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
            {t("notConnected")}
          </span>
        }
        contentClassName="hidden"
      >
        {null}
      </SettingsBlock>
    )
  }

  return (
    <SettingsBlock
      title={t("title")}
      headingLevel={4}
      testid="codex-app-server-status"
      className="@container/codex-status"
      contentClassName="mt-3"
      action={
        <Button
          variant="ghost"
          size="icon-xs"
          className="touch-hit"
          onClick={() => void refresh()}
          disabled={loading}
          aria-busy={loading}
          data-testid="codex-app-server-refresh"
          aria-label={t("refresh")}
        >
          <RefreshCw
            className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")}
            aria-hidden
          />
        </Button>
      }
    >
      <dl className="divide-y divide-border/60">
        {/* Account (from account/read + account/updated) */}
        {(status.account !== undefined || status.requiresOpenaiAuth) && (
          <div className={STATUS_ROW_CLASS_NAME} data-testid="codex-account-section">
            <dt className="flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
              <UserRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("account")}
            </dt>
            <dd className="flex min-w-0 flex-col gap-1.5">
              {status.account ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="break-all" data-testid="codex-account-email">
                    {status.account.email ?? status.account.type ?? "—"}
                  </span>
                  {status.account.planType && (
                    <Badge
                      variant="outline"
                      className="max-w-full whitespace-normal break-all text-[10px]"
                      data-testid="codex-account-plan"
                    >
                      {status.account.planType}
                    </Badge>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="codex-account-signin">
                  {t("signInRequired")}
                </p>
              )}
            </dd>
          </div>
        )}

        {/* Rate limits (from account/rateLimits/read + account/rateLimits/updated) */}
        {status.rateLimits?.primary && (
          <div className={STATUS_ROW_CLASS_NAME} data-testid="codex-rate-limits">
            <dt className="flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
              <Gauge className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("usage")}
            </dt>
            <dd className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Progress
                  value={Math.min(100, Math.max(0, status.rateLimits.primary.usedPercent))}
                  className="h-1.5 min-w-20 flex-1"
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("usedPercent", { percent: status.rateLimits.primary.usedPercent })}
                </span>
              </div>
              {typeof status.rateLimits.primary.resetsAt === "number" && (
                <p
                  className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
                  data-testid="codex-rate-limit-reset"
                >
                  {t("resetsAt", {
                    time: format.dateTime(new Date(status.rateLimits.primary.resetsAt * 1000), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </p>
              )}
              {status.rateLimits.rateLimitReachedType && (
                <Badge
                  variant="destructive"
                  className="max-w-full self-start whitespace-normal break-all text-[10px]"
                  data-testid="codex-rate-limited"
                >
                  {t("rateLimitReached")}
                </Badge>
              )}
            </dd>
          </div>
        )}

        {/* Managed/enterprise limits (configRequirements/read). Cognia refuses a
          request these forbid before sending it, because Codex has no typed
          refusal error to recognise afterwards. */}
        <div className={STATUS_ROW_CLASS_NAME}>
          <dt className="flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("managedPolicy")}
          </dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            {status.configRequirementsUnsupported ? (
              // Inert on purpose, and labelled so: this Codex cannot be asked, which
              // is not the same claim as "this Codex restricts nothing".
              <p
                className="text-xs text-muted-foreground"
                data-testid="codex-requirements-unsupported"
              >
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
                  <Badge
                    key={key}
                    variant="outline"
                    className="max-w-full whitespace-normal break-all text-[10px]"
                  >
                    {label}
                  </Badge>
                ))}
              </div>
            )}
          </dd>
        </div>

        <div className={STATUS_ROW_CLASS_NAME}>
          <dt className="flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
            <Server className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("mcpServers")}
          </dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            {status.mcpServers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noMcpServers")}</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {status.mcpServers.map((server, i) => (
                  <Badge
                    key={server.name ?? i}
                    variant="outline"
                    className="max-w-full whitespace-normal break-all text-[10px]"
                    data-testid="codex-mcp-server"
                  >
                    {server.name ?? "—"}
                    {server.status ? ` · ${server.status}` : ""}
                  </Badge>
                ))}
              </div>
            )}
          </dd>
        </div>

        <div className={STATUS_ROW_CLASS_NAME}>
          <dt className="flex items-start gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("skills")}
          </dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            {status.skills.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noSkills")}</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {status.skills.map((skill, i) => (
                  <Badge
                    key={skill.path ?? skill.name ?? i}
                    variant={skill.enabled === false ? "secondary" : "outline"}
                    className="max-w-full whitespace-normal break-all text-[10px]"
                    data-testid="codex-skill"
                  >
                    {skill.name ?? skill.path ?? "—"}
                  </Badge>
                ))}
              </div>
            )}
          </dd>
        </div>
      </dl>
    </SettingsBlock>
  )
}
