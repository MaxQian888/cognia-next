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
import { useLiveQuery } from "dexie-react-hooks"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { DEFAULT_MAX_CONCURRENCY } from "@/types/workflow/visual"
import { Field, FieldGroup, FieldRow } from "../inspector/forms/shared"
import { DurationField } from "../inspector/forms/shared/duration-field"
import { TimezoneSelect } from "@/components/scheduler/timezone-select"
import { WorkflowVariablesEditor } from "./settings/workflow-variables-editor"
import { WorkflowCredentialsList } from "./settings/workflow-credentials-list"
import { WorkflowPublishSection } from "./settings/workflow-publish-section"
import { PluginCapabilitiesSection } from "./settings/plugin-capabilities-section"
import { FanoutSubscriptionsPanel } from "@/components/workflow/library/fanout-subscriptions-panel"
import { getDb } from "@/lib/db/schema"
import { requireHostFeature } from "@/lib/devices/placement-directory"
import type { DeviceKind } from "@/lib/devices/types"
import { useDeviceOptions } from "@/hooks/devices/use-device-options"

function num(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * A published workflow runs whole on its target, so the only candidates are
 * machines advertising the host-side execution contract. Frozen at module
 * scope: a fresh array each render would rebuild the option list on every
 * keystroke elsewhere in this sidebar.
 */
const RUN_ON_REQUIREMENTS = Object.freeze([requireHostFeature("workflow.execution")])
/*
  SSH hosts are listed too, and always disabled.

  `placementKindFor` returns null for an SSH host, so `buildDeviceOptions` gives
  it `not_permitted` and it renders greyed with a reason. Excluding the kind
  outright made a saved SSH box vanish from this Select with no explanation,
  which is the exact question `placement-directory.ts` says it exists to stop
  people asking. `/devices` already explains it; the picker is where the
  question is actually asked.
*/
const RUN_ON_KINDS: readonly DeviceKind[] = Object.freeze(["remote-host", "ssh-host"])

export function SettingsTab({ useStore }: { useStore: EditorStore }) {
  const t = useTranslations("workflowEditor.settings")
  const {
    settings,
    variables,
    credentials,
    workflowId,
    published,
    syncPublication,
    loadWorkflow,
    setSettings,
    setVariables,
    setCredentials,
  } = useStore(
    useShallow((s: EditorState) => ({
      settings: s.baseWorkflow.settings,
      variables: s.baseWorkflow.variables,
      credentials: s.baseWorkflow.credentials,
      workflowId: s.baseWorkflow.id,
      published: s.baseWorkflow.published,
      syncPublication: s.syncPublication,
      loadWorkflow: s.loadWorkflow,
      setSettings: s.setSettings,
      setVariables: s.setVariables,
      setCredentials: s.setCredentials,
    }))
  )

  const retry = settings.retryDefaults
  const onFailure = settings.onFailure ?? { runCatchNodes: true, notify: false }
  /**
   * Every reachable host, each with a verdict — not just the compatible ones.
   *
   * This used to filter the Select down to hosts whose manifest carried
   * `workflow.execution` and silently drop the rest, so an offline host, an
   * unprobed one, and a machine that simply cannot run workflows were equally
   * invisible. An ineligible candidate now renders disabled with its typed
   * `PlacementReason`, which is the interface half of ADR-0136's visible
   * degradation.
   */
  // `PlacementReason` is a closed, append-only union; its labels live with the
  // device console because that is where the vocabulary is owned.
  const tPlacement = useTranslations("devices.placementReason")
  const tSsh = useTranslations("devices.ssh")
  const hostOptions = useDeviceOptions({ requirements: RUN_ON_REQUIREMENTS, kinds: RUN_ON_KINDS })
  const runOn = settings.runOn ?? { mode: "colocate" as const }
  const runOnValue = runOn.mode === "pinned" ? `pinned:${runOn.ref}` : runOn.mode
  const handoffSummary = useLiveQuery(
    async () => {
      const rows = await getDb()
        .hostDispatchQueue.filter(
          (row) => row.domain === "schedule-handoff" && row.label === workflowId
        )
        .toArray()
      return {
        active: rows.filter((row) => row.status === "pending" || row.status === "inflight").length,
        failed: rows.filter((row) => row.status === "failed" || row.status === "deadletter").length,
      }
    },
    [workflowId],
    { active: 0, failed: 0 }
  )

  const setRunOn = (value: string) => {
    if (value === "colocate" || value === "auto") {
      setSettings({ runOn: { mode: value } })
      return
    }
    if (value.startsWith("pinned:")) {
      const ref = value.slice("pinned:".length)
      if (ref) setSettings({ runOn: { mode: "pinned", ref } })
    }
  }

  return (
    <ScrollArea className="h-full" data-testid="workflow-settings-tab">
      {/* `@container/inspector-form`: this panel shares the Context Workbench
          column with the inspector and is draggable down to 240px, so its
          `FieldRow`s must size against the panel. Only the rows nested in a
          `FieldGroup` would otherwise find a container. */}
      <div className="@container/inspector-form space-y-5 px-4 py-4">
        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("runPolicy.title")}
          </h4>
          <FieldGroup>
            <Field label={t("runOn.label")} htmlFor="wf-run-on" hint={t("runOn.hint")}>
              <Select value={runOnValue} onValueChange={setRunOn} disabled={!published}>
                <SelectTrigger id="wf-run-on" className="w-full" data-testid="wf-run-on">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="colocate">{t("runOn.colocate")}</SelectItem>
                    <SelectItem value="auto">{t("runOn.auto")}</SelectItem>
                  </SelectGroup>
                  {hostOptions.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{t("runOn.pinnedGroup")}</SelectLabel>
                      {hostOptions.map((option) => (
                        <SelectItem
                          key={option.row.ref}
                          value={`pinned:${option.row.ref}`}
                          disabled={!option.eligible}
                        >
                          {option.row.label}
                          {option.verdict.ready ? null : (
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              {/*
                                "Not permitted" is the typed verdict, and for an
                                SSH host it is also the wrong sentence: nothing
                                was denied, the machine simply offers a shell
                                and nothing else. The console already owns that
                                wording, so the picker borrows it rather than
                                widening the closed `PlacementReason` union.
                              */}
                              {option.row.kind === "ssh-host"
                                ? tSsh("shellOnly")
                                : tPlacement(option.verdict.reason)}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
              {!published ? (
                <p className="text-[11px] text-muted-foreground">{t("runOn.publishRequired")}</p>
              ) : hostOptions.every((option) => !option.eligible) ? (
                <p className="text-[11px] text-muted-foreground">{t("runOn.noCompatibleHosts")}</p>
              ) : null}
              {handoffSummary.active > 0 ? (
                <p className="text-[11px] text-muted-foreground" data-testid="wf-handoff-active">
                  {t("runOn.handoffActive", { count: handoffSummary.active })}
                </p>
              ) : null}
              {handoffSummary.failed > 0 ? (
                <p className="text-[11px] text-destructive" data-testid="wf-handoff-failed">
                  {t("runOn.handoffFailed", { count: handoffSummary.failed })}
                </p>
              ) : null}
            </Field>
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
            <FieldRow className="gap-2">
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
                  value={settings.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY}
                  onChange={(e) =>
                    setSettings({
                      maxConcurrency: Math.max(1, num(e.target.value, DEFAULT_MAX_CONCURRENCY)),
                    })
                  }
                />
              </Field>
            </FieldRow>
          </FieldGroup>
        </section>

        <Separator />

        <section className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("retry.title")}
          </h4>
          <FieldRow className="gap-2">
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
          </FieldRow>
        </section>

        <Separator />

        <section className="space-y-3" data-testid="workflow-onfailure-section">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("onFailure.title")}
          </h4>
          <p className="text-[11px] text-muted-foreground">{t("onFailure.hint")}</p>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm">{t("onFailure.runCatchNodes.label")}</p>
              <p className="text-[11px] text-muted-foreground">
                {t("onFailure.runCatchNodes.hint")}
              </p>
            </div>
            <Switch
              checked={onFailure.runCatchNodes !== false}
              onCheckedChange={(v) =>
                setSettings({ onFailure: { ...onFailure, runCatchNodes: v } })
              }
              aria-label={t("onFailure.runCatchNodes.label")}
              data-testid="wf-onfailure-runcatch"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm">{t("onFailure.notify.label")}</p>
              <p className="text-[11px] text-muted-foreground">{t("onFailure.notify.hint")}</p>
            </div>
            <Switch
              checked={Boolean(onFailure.notify)}
              onCheckedChange={(v) => setSettings({ onFailure: { ...onFailure, notify: v } })}
              aria-label={t("onFailure.notify.label")}
              data-testid="wf-onfailure-notify"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm">{t("riskGating.label")}</p>
              <p className="text-[11px] text-muted-foreground">{t("riskGating.hint")}</p>
            </div>
            <Switch
              checked={Boolean(settings.riskGating)}
              onCheckedChange={(v) => setSettings({ riskGating: v })}
              aria-label={t("riskGating.label")}
              data-testid="wf-risk-gating"
            />
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
            {t("publish.title")}
          </h4>
          <WorkflowPublishSection
            workflowId={workflowId}
            published={published}
            onPublicationChange={syncPublication}
            onDraftRestored={(workflow) => loadWorkflow(workflow, { dirty: false })}
          />
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
