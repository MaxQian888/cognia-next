"use client"

/**
 * The project's "Runtime environment" (ADR-0182).
 *
 * One environment definition's runtime selection: which image its agents run
 * in, at what size, lifecycle and isolation, on which agent bundle, with which
 * network presets. Choosing one at all is the project-level opt-in (Q39), so
 * the first control is a switch whose "off" writes no selection whatsoever.
 *
 * # Three things this panel labels as not yet real
 *
 * Working Rule 7 — each is documented at its type, labeled here, and pinned by
 * a test:
 *
 * - **GPU size classes** (`SizeClassView.gpu`): listed, not selectable.
 * - **Local containers** (`PlacementProjectInput.hostRunsLocalContainers`):
 *   the toggle is kept and says a run that sets it is refused.
 * - **Egress enforcement and credential routing**
 *   (`SandboxPlacementReport.egressEnforced` / `credentialsMode`): the
 *   presets are recorded and said to be unenforced; credentials are said to
 *   be the host's own.
 *
 * The browser sidecar is a fourth: the spec carries it, and the Docker driver
 * does not start one yet.
 *
 * # Layout
 *
 * No frame and no heading of its own: the environment manager's "Runtime
 * environment" section names it and says it saves separately. Inside, the
 * five choices are a field grid that goes two-up when the section is wide
 * enough (`@container/environment-card`), and the preview, ports and
 * declaration are sub-blocks under a rule rather than three more bordered
 * boxes inside a bordered card. Its own save sits at its own end, labelled as
 * the runtime's, so it is not mistaken for the editor's.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ProjectEnvironmentRuntimeDeclaration } from "@/components/settings/project-environment-runtime-declaration"
import { ProjectEnvironmentRuntimeTrace } from "@/components/settings/project-environment-runtime-trace"
import {
  defaultRuntimeSelection,
  useProjectRuntimeEnvironment,
} from "@/hooks/sandbox/use-project-runtime-environment"
import { putProjectEnvironment } from "@/lib/db/project-environments"
import {
  readRepositoryCoordinates,
  type RunEnvironmentSources,
} from "@/lib/sandbox/run-environment"
import { useProjectStore } from "@/stores/project/project-store"
import type { ProjectEnvironment, ProjectRuntimeSelection } from "@/types/project-environment"
import type { IsolationTier } from "@/types/sandbox/environment-spec"

const TIERS: readonly IsolationTier[] = ["container", "gvisor", "vm"]
const AUTO = "__auto__"
const DEFAULT = "__default__"

interface Props {
  projectId: string
  executionRoot: string
  /**
   * The stored environment this selection belongs to. `undefined` for a
   * definition that has not been saved yet — there is no row to attach a
   * selection to.
   */
  environment: ProjectEnvironment | undefined
  /** Told the stored runtime after a save, so the editor's draft follows it. */
  onRuntimeSaved?(runtime: ProjectRuntimeSelection | undefined): void
  /** Injected in tests; production takes the composer's own sources. */
  sources?: RunEnvironmentSources
}

export function ProjectEnvironmentRuntime({
  projectId,
  executionRoot,
  environment,
  onRuntimeSaved,
  sources,
}: Props) {
  const t = useTranslations("projectEnvironment.runtime")
  const project = useProjectStore((state) =>
    state.projects.find((candidate) => candidate.id === projectId)
  )
  const [repository, setRepository] = useState<{ remote: string; commitSha: string }>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void readRepositoryCoordinates(executionRoot).then((coordinates) => {
      if (!cancelled) setRepository(coordinates)
    })
    return () => {
      cancelled = true
    }
  }, [executionRoot])

  const onSave = useCallback(
    async (runtime: ProjectRuntimeSelection | undefined) => {
      if (!environment) return
      const now = Date.now()
      const stamped = runtime ? compactSelection({ ...runtime, updatedAt: now }) : undefined
      // Only `runtime` changes. `environment` is the STORED row, so this save
      // cannot publish edits the environment editor has not saved yet.
      const { runtime: _previous, ...rest } = environment
      await putProjectEnvironment({
        ...rest,
        ...(stamped ? { runtime: stamped } : {}),
        updatedAt: now,
      })
      onRuntimeSaved?.(stamped)
      setSaved(true)
    },
    [environment, onRuntimeSaved]
  )

  const state = useProjectRuntimeEnvironment(
    {
      projectId,
      executionRoot,
      project,
      saved: environment?.runtime,
      policy: environment?.policy,
      ...(repository ? { repository } : {}),
      onSave,
    },
    sources
  )
  const { draft, setDraft, catalog, driver } = state

  const update = useCallback(
    (patch: Partial<ProjectRuntimeSelection>) => {
      setSaved(false)
      setDraft({ ...(draft ?? defaultRuntimeSelection()), ...patch })
    },
    [draft, setDraft]
  )

  const chosenEntry = useMemo(() => {
    if (!catalog || !draft) return undefined
    const id =
      draft.source.kind === "catalog" ? draft.source.catalogEntryId : catalog.defaultEntryId
    return catalog.entries.find((entry) => entry.id === id)
  }, [catalog, draft])

  const offeredSizes = useMemo(() => {
    if (!catalog) return []
    const ids = chosenEntry?.sizeClassIds
    return ids ? catalog.sizeClasses.filter((size) => ids.includes(size.id)) : catalog.sizeClasses
  }, [catalog, chosenEntry])

  if (!environment) {
    return (
      <div data-testid="project-environment-runtime">
        <p className="text-xs text-muted-foreground">{t("noEnvironment")}</p>
      </div>
    )
  }

  const available = new Set(driver?.availableTiers ?? [])

  return (
    <div
      className="space-y-4"
      data-testid="project-environment-runtime"
      data-pool={state.loading ? "loading" : state.poolEnabled ? "on" : "off"}
    >
      {state.loading ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          {t("loading")}
        </p>
      ) : null}

      {!state.loading && !state.poolEnabled ? (
        <div role="status" className="space-y-1" data-testid="runtime-pool-off">
          <p className="text-[11px] text-muted-foreground">{t("poolOff")}</p>
          {state.saved ? (
            <p className="text-[11px] text-muted-foreground">{t("poolOffKept")}</p>
          ) : null}
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {state.error}
        </p>
      ) : null}

      {driver ? (
        <div className="space-y-0.5 text-[11px] text-muted-foreground" data-testid="runtime-driver">
          <p>{t("driver", { driver: driver.driver })}</p>
          {driver.reachable ? (
            <p>
              {t("availableTiers", {
                tiers: driver.availableTiers.map((tier) => t(`tier.${tier}`)).join(", "),
              })}
            </p>
          ) : (
            <p className="text-amber-600 dark:text-amber-500">
              {t("driverUnreachable", { reason: driver.unreachableReason ?? "" })}
            </p>
          )}
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={`${environment.id}-runtime-opt-in`} className="text-xs">
            {t("optIn")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("optInHint")}</p>
        </div>
        <Switch
          id={`${environment.id}-runtime-opt-in`}
          checked={draft !== undefined}
          disabled={state.busy}
          onCheckedChange={(checked) => {
            setSaved(false)
            setDraft(checked ? (state.saved ?? defaultRuntimeSelection()) : undefined)
          }}
        />
      </div>

      {draft ? (
        <div
          className="grid gap-x-4 gap-y-3 border-l-2 pl-3 @xl/environment-card:grid-cols-2"
          data-testid="runtime-selection"
        >
          <Field label={t("source")} id={`${environment.id}-runtime-source`}>
            <Select
              value={draft.source.kind === "catalog" ? draft.source.catalogEntryId : AUTO}
              onValueChange={(value) =>
                update({
                  source:
                    value === AUTO ? { kind: "auto" } : { kind: "catalog", catalogEntryId: value },
                  // A size offered by the previous image may not be offered by
                  // this one; the resolver would refuse it.
                  sizeClassId: undefined,
                })
              }
            >
              <SelectTrigger
                id={`${environment.id}-runtime-source`}
                aria-label={t("source")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>{t("sourceAuto")}</SelectItem>
                {(catalog?.entries ?? []).map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.id === catalog?.defaultEntryId
                      ? t("sourceDefault", { label: entry.label })
                      : entry.label}
                  </SelectItem>
                ))}
                {draft.source.kind === "catalog" &&
                !catalog?.entries?.some(
                  (entry) =>
                    draft.source.kind === "catalog" && entry.id === draft.source.catalogEntryId
                ) ? (
                  // Kept visible so the refusal below has something to point at.
                  <SelectItem value={draft.source.catalogEntryId}>
                    {draft.source.catalogEntryId}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("size")} id={`${environment.id}-runtime-size`}>
            <Select
              value={draft.sizeClassId ?? DEFAULT}
              onValueChange={(value) =>
                update({ sizeClassId: value === DEFAULT ? undefined : value })
              }
            >
              <SelectTrigger
                id={`${environment.id}-runtime-size`}
                aria-label={t("size")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>{t("sizeDefault")}</SelectItem>
                {offeredSizes.map((size) => (
                  <SelectItem
                    key={size.id}
                    value={size.id}
                    disabled={Boolean(size.gpu)}
                    data-dormant={size.gpu ? "gpu" : undefined}
                  >
                    {size.gpu
                      ? t("sizeGpuDormant", { label: size.label })
                      : t("sizeSpec", {
                          label: size.label,
                          cpu: size.cpuMillis / 1000,
                          memory: size.memoryMib,
                        })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("lifecycle")} id={`${environment.id}-runtime-lifecycle`}>
            <Select
              value={draft.lifecycle ?? "persistent"}
              onValueChange={(value) =>
                update({ lifecycle: value === "ephemeral" ? "ephemeral" : undefined })
              }
            >
              <SelectTrigger
                id={`${environment.id}-runtime-lifecycle`}
                aria-label={t("lifecycle")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="persistent">{t("lifecyclePersistent")}</SelectItem>
                <SelectItem value="ephemeral">{t("lifecycleEphemeral")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            label={t("isolation")}
            id={`${environment.id}-runtime-isolation`}
            hint={t("isolationMandatoryHint")}
          >
            <Select
              value={draft.isolationMinimum ?? DEFAULT}
              onValueChange={(value) =>
                update({
                  isolationMinimum: value === DEFAULT ? undefined : (value as IsolationTier),
                })
              }
            >
              <SelectTrigger
                id={`${environment.id}-runtime-isolation`}
                aria-label={t("isolation")}
                className="w-full min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT}>
                  {t("isolationFloor", { tier: t(`tier.${catalog?.floor ?? "container"}`) })}
                </SelectItem>
                {TIERS.map((tier) => (
                  <SelectItem key={tier} value={tier}>
                    {driver?.reachable && !available.has(tier)
                      ? t("tierUnavailable", { tier: t(`tier.${tier}`) })
                      : t(`tier.${tier}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("bundle")} id={`${environment.id}-runtime-bundle`}>
            {catalog?.bundle ? (
              <Select
                value={draft.bundlePin?.digest ?? DEFAULT}
                onValueChange={(value) => {
                  const pinned = catalog.bundle?.retained?.find((bundle) => bundle.digest === value)
                  update({
                    bundlePin: pinned
                      ? { digest: pinned.digest, releaseTag: pinned.releaseTag }
                      : undefined,
                  })
                }}
              >
                <SelectTrigger
                  id={`${environment.id}-runtime-bundle`}
                  aria-label={t("bundle")}
                  className="w-full min-w-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>
                    {t("bundleFollow", { tag: catalog.bundle.current.releaseTag })}
                  </SelectItem>
                  {catalog.bundle.retained.map((bundle) => (
                    <SelectItem key={bundle.digest} value={bundle.digest}>
                      {t("bundlePinned", { tag: bundle.releaseTag })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t("bundleNone")}</p>
            )}
          </Field>

          <div className="space-y-1.5 @xl/environment-card:col-span-2" data-testid="runtime-egress">
            <p className="text-xs">{t("egress")}</p>
            <label className="flex items-center gap-2 text-[11px]">
              <Checkbox
                checked={draft.egressPresetIds === undefined}
                onCheckedChange={(checked) =>
                  update({ egressPresetIds: checked === true ? undefined : [] })
                }
              />
              {t("egressAll")}
            </label>
            {draft.egressPresetIds !== undefined
              ? (catalog?.egressPresets ?? []).map((preset) => (
                  <label key={preset.id} className="flex items-center gap-2 pl-5 text-[11px]">
                    <Checkbox
                      checked={draft.egressPresetIds?.includes(preset.id) ?? false}
                      onCheckedChange={(checked) => {
                        const current = draft.egressPresetIds ?? []
                        update({
                          egressPresetIds:
                            checked === true
                              ? [...current, preset.id]
                              : current.filter((id) => id !== preset.id),
                        })
                      }}
                    />
                    {preset.label}
                  </label>
                ))
              : null}
            <p className="text-[11px] text-amber-700 dark:text-amber-400" data-dormant="egress">
              {t("egressNotEnforced")}
            </p>
          </div>

          <Toggle
            id={`${environment.id}-runtime-sidecar`}
            label={t("sidecar")}
            hint={t("sidecarDormant")}
            dormant="sidecar"
            checked={draft.browserSidecar === true}
            onChange={(checked) => update({ browserSidecar: checked || undefined })}
          />

          <Toggle
            id={`${environment.id}-runtime-local`}
            label={t("localContainer")}
            hint={t("localContainerDormant")}
            dormant="local-container"
            checked={draft.localContainer === true}
            onChange={(checked) => update({ localContainer: checked || undefined })}
          />

          <p
            className="text-[11px] text-muted-foreground @xl/environment-card:col-span-2"
            data-dormant="credentials"
          >
            {t("credentials")}
          </p>
        </div>
      ) : null}

      <ProjectEnvironmentRuntimeTrace preview={state.preview} catalog={catalog} />

      {state.ports && state.ports.length > 0 ? (
        <div className="space-y-2 border-t pt-3" data-testid="runtime-ports">
          <h4 className="text-xs font-medium">{t("ports.title")}</h4>
          {!state.portsAvailable ? (
            <p className="text-[11px] text-muted-foreground">{t("ports.desktopRequired")}</p>
          ) : null}
          <ul className="divide-y border-y">
            {state.ports.map((port) => (
              <li
                key={port.path}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5"
              >
                <span className="min-w-0 break-all text-xs">
                  {port.label ? `${port.label} · ${port.port}` : port.port}
                </span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={state.busy || !state.portsAvailable}
                    onClick={() => void state.openPort(port)}
                  >
                    {t("ports.open")}
                  </Button>
                  {state.openedPorts?.[port.path] ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={state.busy}
                      onClick={() => void state.closePort(port.path)}
                    >
                      {t("ports.close")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ProjectEnvironmentRuntimeDeclaration
        files={state.files}
        declaration={state.declaration}
        approvals={state.approvals}
        canApprove={state.poolEnabled}
        busy={state.busy}
        build={state.build}
        onBuild={() => void state.buildEnvironment()}
        onCancelBuild={() => void state.cancelBuild()}
        onApprove={() => void state.approve()}
        onRevoke={(id) => void state.revoke(id)}
      />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
        {saved ? (
          <p role="status" className="mr-auto text-xs text-emerald-600 dark:text-emerald-400">
            {t("saved")}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={state.busy || state.loading}
          onClick={() => void state.save()}
          data-testid="runtime-save"
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
}

/**
 * The selection without keys the form cleared.
 *
 * Every optional field means "the deployment default" when absent. A key
 * present with `undefined` survives into IndexedDB and reads back as a
 * different object — which re-seeds the form and looks like an edit.
 */
export function compactSelection(selection: ProjectRuntimeSelection): ProjectRuntimeSelection {
  return Object.fromEntries(
    Object.entries(selection).filter(([, value]) => value !== undefined)
  ) as unknown as ProjectRuntimeSelection
}

function Field({
  label,
  id,
  hint,
  children,
}: {
  label: string
  id: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Toggle({
  id,
  label,
  hint,
  dormant,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  dormant: string
  checked: boolean
  onChange(checked: boolean): void
}) {
  return (
    <div
      className="flex items-start justify-between gap-3 @xl/environment-card:col-span-2"
      data-dormant={dormant}
    >
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <p className="text-[11px] text-amber-700 dark:text-amber-400">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
