"use client"

import { Play, SlidersHorizontal } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { ProviderSection } from "../provider-section"
import type {
  ProviderDiagnosticCapability,
  ProviderDiagnosticMode,
  ProviderEndpointCandidate,
} from "@cognia/provider-types"

export interface RunComposerProps {
  mode: ProviderDiagnosticMode
  onModeChange: (mode: ProviderDiagnosticMode) => void
  capability: ProviderDiagnosticCapability
  onCapabilityChange: (capability: ProviderDiagnosticCapability) => void
  modelId: string
  onModelIdChange: (modelId: string) => void
  modelIds: string[]
  credentialId: string
  onCredentialIdChange: (credentialId: string) => void
  /** Number of pooled keys beyond the primary credential. */
  credentialPoolSize: number
  endpoint: string
  onEndpointChange: (endpoint: string) => void
  endpointCandidates: ProviderEndpointCandidate[]
  concurrency: number
  onConcurrencyChange: (concurrency: number) => void
  timeoutMs: number
  onTimeoutMsChange: (timeoutMs: number) => void
  remotePaidEnabled: boolean
  onRemotePaidEnabledChange: (enabled: boolean) => void
  onReviewRun: () => void
  /** A job is in flight — the button spins and refuses to queue another. */
  running: boolean
  /** Missing endpoint or (for non-probe runs) missing model. */
  runDisabled: boolean
}

const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 5
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000

/**
 * The "what should we run" form. Every paid run goes through the confirmation
 * dialog the parent owns — this component only ever *proposes* a run
 * (`onReviewRun`), it never starts one.
 */
export function RunComposer({
  mode,
  onModeChange,
  capability,
  onCapabilityChange,
  modelId,
  onModelIdChange,
  modelIds,
  credentialId,
  onCredentialIdChange,
  credentialPoolSize,
  endpoint,
  onEndpointChange,
  endpointCandidates,
  concurrency,
  onConcurrencyChange,
  timeoutMs,
  onTimeoutMsChange,
  remotePaidEnabled,
  onRemotePaidEnabledChange,
  onReviewRun,
  running,
  runDisabled,
}: RunComposerProps) {
  const t = useTranslations("providers.diagnostics")

  return (
    <ProviderSection
      collapsible
      icon={SlidersHorizontal}
      title={t("composer.title")}
      description={t("composer.description")}
    >
      <div className="space-y-4" data-testid="diagnostics-run-composer">
        <div className="grid gap-3 @md/diagnostics:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("composer.mode")}</Label>
            <Select
              value={mode}
              onValueChange={(value) => onModeChange(value as ProviderDiagnosticMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">{t("composer.quick")}</SelectItem>
                <SelectItem value="precise">{t("composer.precise")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("composer.capability")}</Label>
            <Select
              value={capability}
              onValueChange={(value) => onCapabilityChange(value as ProviderDiagnosticCapability)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="probe">{t("composer.probe")}</SelectItem>
                <SelectItem value="text-generation">{t("composer.text")}</SelectItem>
                <SelectItem value="embedding">{t("composer.embedding")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* A probe sends no prompt, so it has no model to pick. */}
        {capability !== "probe" && (
          <div className="space-y-1.5">
            <Label>{t("composer.model")}</Label>
            <Select value={modelId} onValueChange={onModelIdChange}>
              <SelectTrigger>
                <SelectValue placeholder={t("composer.selectModel")} />
              </SelectTrigger>
              <SelectContent>
                {modelIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid gap-3 @md/diagnostics:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("composer.credential")}</Label>
            <Select value={credentialId} onValueChange={onCredentialIdChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">{t("composer.primaryCredential")}</SelectItem>
                {Array.from({ length: credentialPoolSize }, (_, index) => (
                  <SelectItem key={index} value={`pool:${index}`}>
                    {t("composer.poolCredential", { index: index + 1 })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("composer.endpoint")}</Label>
            <Select value={endpoint} onValueChange={onEndpointChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {endpointCandidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.url}>
                    {candidate.label ?? candidate.url}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-3 @md/diagnostics:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="diagnostics-concurrency">{t("composer.concurrency")}</Label>
            <Input
              id="diagnostics-concurrency"
              type="number"
              min={MIN_CONCURRENCY}
              max={MAX_CONCURRENCY}
              value={concurrency}
              onChange={(event) =>
                onConcurrencyChange(
                  Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Number(event.target.value)))
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="diagnostics-timeout">{t("composer.timeout")}</Label>
            <Input
              id="diagnostics-timeout"
              type="number"
              min={MIN_TIMEOUT_MS}
              max={MAX_TIMEOUT_MS}
              step={1_000}
              value={timeoutMs}
              onChange={(event) =>
                onTimeoutMsChange(Math.max(MIN_TIMEOUT_MS, Number(event.target.value)))
              }
            />
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          {t("composer.preview", {
            requests: mode === "precise" ? 4 : 1,
            concurrency,
            timeout: Math.round(timeoutMs / 1_000),
          })}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <Label htmlFor="remote-paid-diagnostics">{t("composer.remotePaid")}</Label>
            <p className="text-xs text-muted-foreground">{t("composer.remotePaidDescription")}</p>
          </div>
          <Switch
            id="remote-paid-diagnostics"
            checked={remotePaidEnabled}
            onCheckedChange={onRemotePaidEnabledChange}
          />
        </div>

        <Button className="w-full gap-2" onClick={onReviewRun} disabled={runDisabled || running}>
          {running ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {t("composer.reviewRun")}
        </Button>
      </div>
    </ProviderSection>
  )
}
