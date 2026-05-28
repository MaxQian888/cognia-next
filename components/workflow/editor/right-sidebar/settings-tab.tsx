"use client"

/**
 * SettingsTab — workflow-level configuration surfaced in the editor's right
 * sidebar (peer of Chat / Inspector / Templates / Changelog). Edits flow
 * through the editor store's envelope mutators (`setSettings` / `setVariables`
 * / `setCredentials`), which mark the workflow dirty so the existing Ctrl+S /
 * toolbar save path persists them — no bespoke persistence here.
 */

import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { Field, FieldGroup } from "../inspector/forms/shared"
import { DurationField } from "../inspector/forms/shared/duration-field"
import { TimezoneSelect } from "@/components/scheduler/timezone-select"
import { WorkflowVariablesEditor } from "./settings/workflow-variables-editor"
import { WorkflowCredentialsList } from "./settings/workflow-credentials-list"
import { PluginCapabilitiesSection } from "./settings/plugin-capabilities-section"
import { FanoutSubscriptionsPanel } from "@/components/workflow/library/fanout-subscriptions-panel"

function num(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function SettingsTab({ useStore }: { useStore: EditorStore }) {
  const t = useTranslations("workflowEditor.settings")
  const {
    settings,
    variables,
    credentials,
    workflowId,
    setSettings,
    setVariables,
    setCredentials,
  } = useStore(
    useShallow((s: EditorState) => ({
      settings: s.baseWorkflow.settings,
      variables: s.baseWorkflow.variables,
      credentials: s.baseWorkflow.credentials,
      workflowId: s.baseWorkflow.id,
      setSettings: s.setSettings,
      setVariables: s.setVariables,
      setCredentials: s.setCredentials,
    }))
  )

  const retry = settings.retryDefaults

  return (
    <ScrollArea className="h-full" data-testid="workflow-settings-tab">
      <div className="space-y-5 px-4 py-4">
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("runPolicy.title")}
          </h4>
          <FieldGroup>
            <Field label={t("errorPolicy.label")} htmlFor="wf-error-policy">
              <Select
                value={settings.errorPolicy}
                onValueChange={(v) =>
                  setSettings({ errorPolicy: v as typeof settings.errorPolicy })
                }
              >
                <SelectTrigger id="wf-error-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stop">{t("errorPolicy.stop")}</SelectItem>
                  <SelectItem value="continue">{t("errorPolicy.continue")}</SelectItem>
                  <SelectItem value="branch">{t("errorPolicy.branch")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("timeoutMs.label")} htmlFor="wf-timeout" hint={t("timeoutMs.hint")}>
              <DurationField
                id="wf-timeout"
                value={settings.timeoutMs}
                onChange={(ms) => setSettings({ timeoutMs: ms })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label={t("concurrency.label")}
                htmlFor="wf-concurrency"
                hint={t("concurrency.hint")}
              >
                <Input
                  id="wf-concurrency"
                  type="number"
                  min={1}
                  value={settings.concurrency}
                  onChange={(e) =>
                    setSettings({ concurrency: Math.max(1, num(e.target.value, 1)) })
                  }
                />
              </Field>
              <Field
                label={t("maxConcurrency.label")}
                htmlFor="wf-max-concurrency"
                hint={t("maxConcurrency.hint")}
              >
                <Input
                  id="wf-max-concurrency"
                  type="number"
                  min={1}
                  value={settings.maxConcurrency ?? 1}
                  onChange={(e) =>
                    setSettings({ maxConcurrency: Math.max(1, num(e.target.value, 1)) })
                  }
                />
              </Field>
            </div>
          </FieldGroup>
        </section>

        <Separator />

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("retry.title")}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("retry.attempts")} htmlFor="wf-retry-attempts">
              <Input
                id="wf-retry-attempts"
                type="number"
                min={1}
                value={retry.attempts}
                onChange={(e) =>
                  setSettings({
                    retryDefaults: { ...retry, attempts: Math.max(1, num(e.target.value, 1)) },
                  })
                }
              />
            </Field>
            <Field label={t("retry.backoff")} htmlFor="wf-retry-backoff">
              <Select
                value={retry.backoff}
                onValueChange={(v) =>
                  setSettings({
                    retryDefaults: { ...retry, backoff: v as "exponential" | "fixed" },
                  })
                }
              >
                <SelectTrigger id="wf-retry-backoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exponential">{t("retry.exponential")}</SelectItem>
                  <SelectItem value="fixed">{t("retry.fixed")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("retry.baseMs")} htmlFor="wf-retry-base">
              <Input
                id="wf-retry-base"
                type="number"
                min={0}
                value={retry.baseMs}
                onChange={(e) =>
                  setSettings({
                    retryDefaults: { ...retry, baseMs: Math.max(0, num(e.target.value, 0)) },
                  })
                }
              />
            </Field>
            <Field label={t("retry.maxMs")} htmlFor="wf-retry-max">
              <Input
                id="wf-retry-max"
                type="number"
                min={0}
                value={retry.maxMs ?? 0}
                onChange={(e) =>
                  setSettings({
                    retryDefaults: { ...retry, maxMs: Math.max(0, num(e.target.value, 0)) },
                  })
                }
              />
            </Field>
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("timezone.label")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("timezone.hint")}</p>
          <TimezoneSelect
            value={settings.timezone}
            onValueChange={(tz) => setSettings({ timezone: tz })}
            testId="wf-timezone"
          />
        </section>

        <Separator />

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("variables.title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("variables.hint")}</p>
          <WorkflowVariablesEditor value={variables ?? {}} onChange={setVariables} />
        </section>

        <Separator />

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("credentials.title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("credentials.hint")}</p>
          <WorkflowCredentialsList value={credentials ?? {}} onChange={setCredentials} />
        </section>

        <Separator />

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("plugins.title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("plugins.hint")}</p>
          <PluginCapabilitiesSection />
        </section>

        <Separator />

        {/*
          Run-progress fan-out (im-a2ui-abstract-anchor Phase 7). The
          panel queries `workflowFanoutSubscriptions` live, so adds /
          removes are reflected immediately and the progress-runner
          picks them up on the NEXT run.
        */}
        <section className="space-y-3">
          <FanoutSubscriptionsPanel workflowId={workflowId} />
        </section>
      </div>
    </ScrollArea>
  )
}
