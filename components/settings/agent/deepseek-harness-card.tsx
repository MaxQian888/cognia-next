"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, CheckCircle2, Download, RefreshCw, Trash2, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDshRuntime } from "@/hooks/agent/use-dsh-runtime"
import type { DshDoctorFinding } from "@/lib/ai/agent/external/dsh-runtime-install"
import {
  dshCapabilitiesForTransport,
  profileTransport,
  type DshProfileId,
} from "@/types/agent/dsh-runtime-channel"

/**
 * Manage the Cognia-owned DeepSeek Harness runtime.
 *
 * Unlike every other external-agent surface, this one owns an install: DSH
 * publishes no executable for the transport Cognia drives, so there is nothing
 * on PATH to detect and the runtime has to be installed and certified here.
 *
 * The capability rows are not decoration. This transport cannot ask for
 * approval mid-turn and cannot cancel a single turn, and a user who does not
 * know that before starting a run will be surprised by both.
 */

interface DeepSeekHarnessCardProps {
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
  profileId = "cognia-sdk-readonly",
}: DeepSeekHarnessCardProps) {
  const t = useTranslations("externalAgent.settings.deepseekHarness")
  const { supported, report, busy, error, installed, refresh, install, remove } =
    useDshRuntime(profileId)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const capabilities = dshCapabilitiesForTransport(profileTransport(profileId))
  const capabilityRows = [
    ["capabilityStreaming", capabilities.streamingDeltas],
    ["capabilityToolEvents", capabilities.toolEvents],
    ["capabilityReasoning", capabilities.reasoning],
    ["capabilityUsage", capabilities.usage],
    ["capabilitySubagents", capabilities.subagentLineage],
    ["capabilityApproval", capabilities.interactiveApproval],
    ["capabilityCancel", capabilities.turnCancellation],
  ] as const

  if (!supported) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t("description")}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="deepseek-harness-card">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
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

      <div className="flex items-center gap-2 text-xs" data-testid="dsh-status">
        {installed ? (
          report?.healthy ? (
            <CheckCircle2 className="size-3.5 text-emerald-600" />
          ) : (
            <AlertTriangle className="size-3.5 text-amber-600" />
          )
        ) : (
          <XCircle className="size-3.5 text-muted-foreground" />
        )}
        <span>
          {!installed ? t("notInstalled") : report?.healthy ? t("healthy") : t("unhealthy")}
        </span>
      </div>

      {installed && report && !report.healthy ? (
        <ul className="space-y-1" data-testid="dsh-findings">
          {report.findings.map((finding, index) => (
            <li
              key={`${finding.code}-${index}`}
              className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
            >
              {t(`findings.${FINDING_KEYS[finding.code]}`)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-1" data-testid="dsh-capabilities">
        <p className="text-xs font-medium">{t("capabilities")}</p>
        {capabilityRows.map(([key, enabled]) => (
          <div key={key} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t(key)}</span>
            <span>{enabled ? t("capabilitySupported") : t("capabilityUnsupported")}</span>
          </div>
        ))}
      </div>

      {/* Stated up front, not discovered mid-run. */}
      <p className="text-xs text-muted-foreground">{t("approvalNotice")}</p>
      <p className="text-xs text-muted-foreground">{t("cancelNotice")}</p>

      {error ? (
        <p className="text-xs text-destructive" role="alert" data-testid="dsh-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void install()} disabled={busy} data-testid="dsh-install">
          <Download className="mr-1 size-3.5" />
          {busy ? t("installing") : installed ? t("reinstall") : t("install")}
        </Button>
        {installed ? (
          confirmingRemove ? (
            <Button
              size="sm"
              variant="destructive"
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
