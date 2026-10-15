"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, CheckCircle2, Download, RefreshCw, Trash2, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDshRuntime } from "@/hooks/agent/use-dsh-runtime"
import type { DshDoctorFinding } from "@cognia/agent-dsh/install"
import {
  dshCapabilitiesForTransport,
  profileTransport,
  type DshProfileId,
} from "@cognia/agent-dsh/channel"

/**
 * Manage the Cognia-owned DeepSeek Harness runtime.
 *
 * Cognia installs the pinned official DSH runtime in an isolated home and
 * certifies its dependencies and launch profiles before accepting connections.
 *
 * Capability rows and notices describe the selected profile: SDK native
 * approval and cancellation differ from ACP and from the Cognia tool broker.
 */

interface DeepSeekHarnessCardProps {
  profile?: DshProfileId
  profileId?: DshProfileId
}

/** Maps a doctor finding code to its i18n key. */
const FINDING_KEYS: Record<DshDoctorFinding["code"], string> = {
  "channel-malformed": "channelMalformed",
  "lockfile-digest-mismatch": "lockfileDigestMismatch",
  "composition-digest-mismatch": "compositionDigestMismatch",
  "node-version-unsupported": "nodeVersionUnsupported",
  "platform-unsupported": "platformUnsupported",
  "stray-patch-layer": "strayPatchLayer",
  "native-toolchain-missing": "nativeToolchainMissing",
}

export function DeepSeekHarnessCard({
  profile,
  profileId = profile ?? "cognia-sdk-readonly",
}: DeepSeekHarnessCardProps) {
  const t = useTranslations("externalAgent.settings.deepseekHarness")
  const { supported, report, busy, error, installed, refresh, install, remove } =
    useDshRuntime(profileId)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const capabilities = dshCapabilitiesForTransport(profileTransport(profileId))
  const capabilityRows = [
    ["capabilityStreaming", capabilities.streamingDeltas],
    ["capabilityToolEvents", capabilities.toolEvents],
    ["capabilityMcp", capabilities.mcpPassthrough],
    ["capabilityReasoning", capabilities.reasoning],
    ["capabilityUsage", capabilities.usage],
    ["capabilitySubagents", capabilities.subagentLineage],
    ["capabilityApproval", capabilities.interactiveApproval],
    ["capabilityCancel", capabilities.turnCancellation],
  ] as const

  if (!supported) {
    return <p className="text-xs text-muted-foreground">{t("description")}</p>
  }

  return (
    <div
      className="@container/settings-stack space-y-3 rounded-md border p-3"
      data-testid="deepseek-harness-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{t("title")}</p>
            <Badge variant="outline">{t("experimentalBadge")}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label={t("doctor")}
          data-testid="dsh-refresh"
        >
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>

      <p className="rounded bg-muted/50 p-2 text-xs text-muted-foreground">
        {t("experimentalNotice")}
      </p>

      {report || !error ? (
        <div className="flex items-center gap-2 text-xs" role="status" data-testid="dsh-status">
          {!report ? (
            <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />
          ) : installed ? (
            report?.healthy ? (
              <CheckCircle2 className="size-3.5 text-emerald-600" />
            ) : (
              <AlertTriangle className="size-3.5 text-amber-600" />
            )
          ) : (
            <XCircle className="size-3.5 text-muted-foreground" />
          )}
          <span>
            {!report
              ? t("checking")
              : !installed
                ? t("notInstalled")
                : report.healthy
                  ? t("healthy")
                  : t("unhealthy")}
          </span>
        </div>
      ) : null}

      {installed && report && !report.healthy ? (
        <ul className="divide-y divide-amber-500/20" data-testid="dsh-findings">
          {report.findings.map((finding, index) => (
            <li
              key={`${finding.code}-${index}`}
              className="py-2 text-xs text-amber-800 dark:text-amber-300"
            >
              {t(`findings.${FINDING_KEYS[finding.code]}`)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-1" data-testid="dsh-capabilities">
        <p className="text-xs font-medium">{t("capabilities")}</p>
        {capabilityRows.map(([key, enabled]) => (
          <div key={key} className="flex items-start justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{t(key)}</span>
            <span>{enabled ? t("capabilitySupported") : t("capabilityUnsupported")}</span>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t("committedEventsNotice")}</p>

      {/* Stated up front, not discovered mid-run. */}
      {!capabilities.interactiveApproval && (
        <p className="text-xs text-muted-foreground">{t("approvalNotice")}</p>
      )}
      {!capabilities.turnCancellation && (
        <p className="text-xs text-muted-foreground">{t("cancelNotice")}</p>
      )}

      {error ? (
        <div className="space-y-2">
          <p className="break-words text-xs text-destructive" role="alert" data-testid="dsh-error">
            {error}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="w-full @md/settings-stack:w-auto [[data-detail-density=stacked]_&]:w-full"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {t("retry")}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 @md/settings-stack:flex-row [[data-detail-density=stacked]_&]:flex-col [[data-detail-density=stacked]_&]:items-stretch @md/settings-stack:flex-wrap @md/settings-stack:items-center">
        <Button
          size="sm"
          onClick={() => void install()}
          disabled={busy || !report}
          data-testid="dsh-install"
        >
          <Download className="mr-1 size-3.5" />
          {busy && !report
            ? t("checking")
            : busy
              ? t("installing")
              : installed
                ? t("reinstall")
                : t("install")}
        </Button>
        {installed ? (
          confirmingRemove ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-auto whitespace-normal"
              onClick={() => {
                setConfirmingRemove(false)
                void remove()
              }}
              disabled={busy}
              data-testid="dsh-remove-confirm"
            >
              {t("removeConfirm")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmingRemove(true)}
              disabled={busy}
              data-testid="dsh-remove"
            >
              <Trash2 className="mr-1 size-3.5" />
              {t("remove")}
            </Button>
          )
        ) : null}
      </div>
    </div>
  )
}

export default DeepSeekHarnessCard
