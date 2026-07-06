"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  SendIcon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DomainListInput } from "@/components/settings/search/_shared/domain-list-input"
import { isTauri } from "@/lib/tauri"
import { remoteControlGetToken, remoteControlRotateToken } from "@/lib/tauri/remote-control"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import {
  groupRemoteCommandTargets,
  isLoopbackAllowlistEntry,
  isRemoteCommandTargetEnabled,
  isSensitiveRemoteCommandTarget,
  REMOTE_COMMAND_TARGETS,
  type RemoteCommandTarget,
  SENSITIVE_REMOTE_COMMAND_TARGETS,
  validateCidrOrIp,
} from "@/types/remote-control"

export function InboundTab() {
  const t = useTranslations("settings.remoteControl.inbound")
  const desktop = isTauri()
  const inbound = useRemoteControlStore((s) => s.config.inbound)
  const status = useRemoteControlStore((s) => s.status)
  const updateInbound = useRemoteControlStore((s) => s.updateInbound)
  const startInbound = useRemoteControlStore((s) => s.startInbound)
  const stopInbound = useRemoteControlStore((s) => s.stopInbound)
  const hydrate = useRemoteControlStore((s) => s.hydrate)

  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [revealedToken, setRevealedToken] = useState<string | null>(null)

  useEffect(() => {
    if (desktop) void hydrate()
  }, [desktop, hydrate])

  if (!desktop) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
        <AlertTriangleIcon className="mb-2 inline h-4 w-4" /> {t("desktopOnlyNotice")}
      </div>
    )
  }

  const endpointUrl = `http://127.0.0.1:${inbound.port}`
  const hasNonLoopback = inbound.allowlist.some((entry) => !isLoopbackAllowlistEntry(entry))

  const disabledTargets = inbound.disabledTargets ?? []
  const targetGroups = groupRemoteCommandTargets()
  const enabledTargetCount = REMOTE_COMMAND_TARGETS.filter((target) =>
    isRemoteCommandTargetEnabled(disabledTargets, target)
  ).length

  const onToggleTarget = (target: RemoteCommandTarget, enabled: boolean) => {
    const next = new Set(disabledTargets)
    if (enabled) next.delete(target)
    else next.add(target)
    void updateInbound({ disabledTargets: [...next] })
  }
  const onEnableAllTargets = () => void updateInbound({ disabledTargets: [] })
  const onDisableAllTargets = () =>
    void updateInbound({ disabledTargets: [...REMOTE_COMMAND_TARGETS] })

  // Quickstart snippets use a $COGNIA_RC_TOKEN placeholder rather than the real
  // token so copying to a shared terminal history never leaks the bearer.
  const healthSnippet = `curl -sS ${endpointUrl}/api/v1/health \\\n  -H "Authorization: Bearer $COGNIA_RC_TOKEN"`
  const commandSnippet = `curl -sS -X POST ${endpointUrl}/api/v1/commands/scheduler.task.run \\\n  -H "Authorization: Bearer $COGNIA_RC_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"args":{"taskId":"<task-id>"}}'`

  const onCopySnippet = async (snippet: string) => {
    await navigator.clipboard.writeText(snippet).catch(() => {})
    toast.success(t("quickstartCopied"))
  }

  const onRevealToken = async () => {
    try {
      const token = await remoteControlGetToken()
      if (!token) {
        toast.error(t("enabledRequiresToken"))
        return
      }
      setRevealedToken(token)
      setTokenRevealed(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const onCopyToken = async () => {
    try {
      const token = revealedToken ?? (await remoteControlGetToken())
      if (!token) {
        toast.error(t("enabledRequiresToken"))
        return
      }
      await navigator.clipboard.writeText(token)
      toast.success(t("tokenCopied"))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const onRotateToken = async () => {
    try {
      const token = await remoteControlRotateToken()
      setRevealedToken(token)
      setTokenRevealed(true)
      await hydrate()
      toast.success(t("tokenCopied"))
      await navigator.clipboard.writeText(token).catch(() => {})
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const onToggleEnabled = async (next: boolean) => {
    if (next && !status.hasInboundToken) {
      toast.error(t("enabledRequiresToken"))
      return
    }
    if (next) {
      const result = await startInbound()
      if (!result.ok) toast.error(t("startError", { error: result.error ?? "" }))
    } else {
      const result = await stopInbound()
      if (!result.ok) toast.error(t("stopError", { error: result.error ?? "" }))
    }
  }

  const onAddAllowlistEntry = (raw: string) => {
    void updateInbound({ allowlist: [...inbound.allowlist, raw] })
  }

  const onRemoveAllowlistEntry = (entry: string) => {
    void updateInbound({ allowlist: inbound.allowlist.filter((e) => e !== entry) })
  }

  const onTestInbound = async () => {
    try {
      const token = await remoteControlGetToken()
      if (!token) {
        toast.error(t("enabledRequiresToken"))
        return
      }
      const response = await fetch(`${endpointUrl}/api/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        toast.error(t("testFailed", { error: `HTTP ${response.status}` }))
        return
      }
      toast.success(t("testSucceeded"))
    } catch (error) {
      toast.error(
        t("testFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("enabled")}</CardTitle>
          <CardDescription>{t("enabledHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="rc-inbound-enabled">{t("enabled")}</Label>
            <Switch
              id="rc-inbound-enabled"
              disabled={!status.hasInboundToken}
              checked={status.inboundRunning}
              onCheckedChange={onToggleEnabled}
            />
          </div>
          {!status.hasInboundToken && (
            <p className="text-xs text-muted-foreground">{t("enabledRequiresToken")}</p>
          )}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="rc-inbound-port" className="flex-1">
              {t("port")}
            </Label>
            <Input
              id="rc-inbound-port"
              type="number"
              min={1024}
              max={65535}
              className="w-28"
              value={inbound.port}
              onChange={(e) => {
                const next = Math.min(
                  65535,
                  Math.max(1024, Number.parseInt(e.target.value || "0", 10) || 47821)
                )
                void updateInbound({ port: next })
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("portHelp")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <KeyRoundIcon className="h-4 w-4" />
            {t("token")}
          </CardTitle>
          <CardDescription>{t("tokenHidden")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={tokenRevealed ? (revealedToken ?? "") : "••••••••••••••••••••••••••••••••"}
              className="font-mono text-xs"
            />
            <Button size="sm" variant="outline" onClick={onRevealToken}>
              {tokenRevealed ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              <span className="ml-1.5 sr-only">
                {tokenRevealed ? t("tokenRevealHide") : t("tokenRevealShow")}
              </span>
            </Button>
            <Button size="sm" variant="outline" onClick={onCopyToken}>
              <CopyIcon className="h-4 w-4" />
              <span className="ml-1.5 sr-only">{t("copyToken")}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={onRotateToken}>
              <RefreshCwIcon className="h-4 w-4" />
              <span className="ml-1.5 sr-only">{t("rotateToken")}</span>
            </Button>
          </div>
          {!status.hasInboundToken && (
            <Button size="sm" onClick={onRotateToken}>
              {t("generateToken")}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("allowlist")}</CardTitle>
          <CardDescription>{t("allowlistHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <DomainListInput
            label={t("allowlist")}
            placeholder={t("allowlistPlaceholder")}
            domains={inbound.allowlist}
            onAdd={onAddAllowlistEntry}
            onRemove={onRemoveAllowlistEntry}
            removeAriaLabel={(entry) => `${t("rotateToken")} ${entry}`}
            showAddButton
            validate={validateCidrOrIp}
            errorRender={(key) =>
              t(key.replace(/^settings\.remoteControl\.inbound\./, "") as never)
            }
          />
          {hasNonLoopback && (
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("nonLoopbackWarning")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("rateLimit")}</CardTitle>
          <CardDescription>{t("rateLimitHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="rc-inbound-rate-limit" className="flex-1">
              {t("rateLimit")}
            </Label>
            <Input
              id="rc-inbound-rate-limit"
              type="number"
              min={1}
              max={6000}
              className="w-28"
              value={inbound.rateLimitPerMin}
              onChange={(e) => {
                const next = Math.max(1, Number.parseInt(e.target.value || "0", 10) || 60)
                void updateInbound({ rateLimitPerMin: next })
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("endpointUrl")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
              {endpointUrl}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(endpointUrl).catch(() => {})
              }}
            >
              <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("copyEndpoint")}
            </Button>
          </div>
          <Button size="sm" variant="outline" onClick={onTestInbound}>
            <SendIcon className="mr-2 h-3.5 w-3.5" />
            {t("testInbound")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("capabilityHeading")}</CardTitle>
          <CardDescription>{t("capabilityHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {(["read", "write"] as const).map((cap) => (
              <Button
                key={cap}
                size="sm"
                variant={inbound.capability === cap ? "default" : "outline"}
                onClick={() => void updateInbound({ capability: cap })}
              >
                {t(`capability_${cap}` as never)}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("capabilityRestartNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-sm font-medium">
                {t("commandPermissionsHeading")}
              </CardTitle>
              <CardDescription>{t("commandPermissionsHelp")}</CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={onEnableAllTargets}>
                {t("commandPermissionsEnableAll")}
              </Button>
              <Button size="sm" variant="ghost" onClick={onDisableAllTargets}>
                {t("commandPermissionsDisableAll")}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("commandPermissionsEnabledCount", {
              enabled: enabledTargetCount,
              total: REMOTE_COMMAND_TARGETS.length,
            })}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {targetGroups.map(({ group, targets }) => (
            <div key={group} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t(`commandGroup_${group}` as never)}
              </p>
              <ul className="space-y-1">
                {targets.map((target) => {
                  const enabled = isRemoteCommandTargetEnabled(disabledTargets, target)
                  return (
                    <li
                      key={target}
                      className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5"
                    >
                      <Switch
                        id={`rc-target-${target}`}
                        checked={enabled}
                        onCheckedChange={(v) => onToggleTarget(target, v)}
                        aria-label={t("commandPermissionsToggleAria", { target })}
                      />
                      <code
                        className={`flex-1 truncate font-mono text-xs ${
                          enabled ? "" : "text-muted-foreground line-through"
                        }`}
                      >
                        POST /api/v1/commands/{target}
                      </code>
                      {isSensitiveRemoteCommandTarget(target) && (
                        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          {t("sensitiveBadge")}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("capabilityRestartNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("sensitiveHeading")}</CardTitle>
          <CardDescription>{t("sensitiveHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="rc-allow-sensitive" className="text-sm">
              {t("sensitiveToggleLabel")}
            </Label>
            <Switch
              id="rc-allow-sensitive"
              checked={inbound.allowSensitiveTargets}
              onCheckedChange={(checked) => void updateInbound({ allowSensitiveTargets: checked })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("sensitiveTargetsList", {
              targets: SENSITIVE_REMOTE_COMMAND_TARGETS.join(", "),
            })}
          </p>
          <p className="text-xs text-muted-foreground">{t("capabilityRestartNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <TerminalIcon className="h-4 w-4" />
            {t("quickstartHeading")}
          </CardTitle>
          <CardDescription>{t("quickstartHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(
            [
              { label: t("quickstartHealthLabel"), snippet: healthSnippet },
              { label: t("quickstartCommandLabel"), snippet: commandSnippet },
            ] as const
          ).map(({ label, snippet }) => (
            <div key={label} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                <Button size="sm" variant="ghost" onClick={() => onCopySnippet(snippet)}>
                  <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
                  {t("quickstartCopy")}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2.5 text-[11px] leading-relaxed">
                <code>{snippet}</code>
              </pre>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("hardeningHeading")}</CardTitle>
          <CardDescription>{t("hardeningHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• {t("hardeningHost")}</li>
            <li>• {t("hardeningOrigin")}</li>
            <li>• {t("hardeningIdempotency")}</li>
            <li>• {t("hardeningCsp")}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
