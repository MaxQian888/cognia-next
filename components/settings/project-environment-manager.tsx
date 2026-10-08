"use client"

/**
 * A workspace's execution environments: what the repository ships, what a
 * worktree needs, and the environments this device defines on top.
 *
 * Mounted in two places with very different widths: the Environments tab of
 * `/workspace` (a full pane) and the session settings sheet (~448px). The
 * layout sizes off its own width (`@container/environment-pane`), never the
 * viewport, so the sheet and the page each get the arrangement that fits
 * them on the same monitor.
 *
 * # Layout
 *
 * No frames. It used to be a bordered box holding bordered boxes four levels
 * deep (repository card, provisioning card, a bootstrap card with a bordered
 * fieldset inside, a box per action, a runtime card with a ports box and two
 * more boxes inside), so a 448px sheet lost a third of its width to nested
 * gutters and nothing said which box belonged to which. Every part is now a
 * `ProjectEnvironmentSection` chapter, a heading over a hairline rule.
 *
 *  * What the repository ships and what a worktree needs come first, side by
 *    side on a wide pane: they are the stronger statements, and the local
 *    environment is merged on top of them.
 *  * The environments are a list to pick from with the editor beside it (on
 *    a wide pane) or under it (in the sheet). The list replaced a `Select`
 *    that showed one name and hid which environment was the default, which
 *    was switched off and whether its setup last succeeded.
 *  * The editor's verbs sit in a bar that stays at the bottom of the scroll
 *    while the form is on screen. They used to be at the very end of a form
 *    several screens long, under the runtime panel's own Save button, so the
 *    nearest "Save" to most fields saved something else.
 *
 * # Edits are not lost silently
 *
 * Picking another environment, starting a new one, or a reload behind the
 * editor used to replace the working copy without a word. The editor now
 * knows when it holds unsaved edits: it says so in the bar, offers to discard
 * them, asks before anything would drop them, and a reload keeps them.
 * Deleting asks first, and a delete or a setup run that throws reports it
 * instead of leaving the panel disabled.
 *
 * # The repository wins where it applies
 *
 * Once the repository's `.cognia/workspace.json` is approved, its setup
 * script and actions replace this device's (`mergeWorkspaceConfig`). The
 * editor kept offering both as if they would run, so the sections that are
 * replaced now say so, and the variables and keyring sections say which local
 * values override the repository's and which required secrets are unbound.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ChevronRightIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, Undo2Icon } from "lucide-react"

import { CapabilityGate } from "@/components/platform/capability-gate"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useRepoWorkspaceConfig } from "@/hooks/workspace/use-repo-workspace-config"
import {
  deleteProjectEnvironment,
  hydrateProjectEnvironment,
  listProjectEnvironments,
  putProjectEnvironment,
} from "@/lib/db/project-environments"
import { executeProjectEnvironment } from "@/lib/project-environment/executor"
import {
  assertBootstrapEnvironment,
  BootstrapAgentValidationError,
} from "@/lib/project-environment/bootstrap-agent"
import { mergeWorkspaceConfig } from "@/lib/project-environment/workspace-config"
import { cn } from "@/lib/utils"
import { ProjectEnvironmentBootstrap } from "./project-environment-bootstrap"
import { ProjectEnvironmentList } from "./project-environment-list"
import { ProjectEnvironmentProvisioning } from "./project-environment-provisioning"
import { ProjectEnvironmentRepoConfigView } from "./project-environment-repo-config"
import { ProjectEnvironmentRuntime } from "./project-environment-runtime"
import { ProjectEnvironmentSection } from "./project-environment-section"
import {
  ProjectEnvironmentSetupReuseFields,
  finalizeSetupReuse,
} from "./project-environment-setup-reuse"
import { useProjectStore } from "@/stores/project/project-store"
import type {
  ProjectEnvironment,
  ProjectEnvironmentAction,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

interface VariableRow {
  name: string
  value: string
}

interface SecretRow {
  variable: string
  keyringRef: string
}

const OSES = ["macos", "windows", "linux"] as const

function emptyEnvironment(projectId: string): ProjectEnvironment {
  const now = Date.now()
  return {
    id: `project-environment:${crypto.randomUUID()}`,
    projectId,
    name: "",
    isEnabled: true,
    setupScript: { default: "", byOs: {} },
    actions: [],
    variables: {},
    keyringReferences: [],
    createdAt: now,
    updatedAt: now,
  }
}

function plainVariables(rows: readonly VariableRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value])
  )
}

function keyringReferences(rows: readonly SecretRow[]): ProjectEnvironment["keyringReferences"] {
  return rows
    .filter((row) => row.variable.trim() && row.keyringRef.trim())
    .map((row) => ({ variable: row.variable.trim(), keyringRef: row.keyringRef.trim() }))
}

/**
 * What the editor would save, as a comparable string.
 *
 * `runtime` is left out: the runtime section saves it on its own and feeds it
 * back into both the stored row and the working copy, so it never makes the
 * editor dirty. So are the fields a run or a save stamps (`updatedAt`, the
 * initialization record), which change without the user editing anything.
 */
export function editorSnapshot(
  draft: ProjectEnvironment | null,
  variables: readonly VariableRow[],
  secrets: readonly SecretRow[],
  isDefault: boolean
): string {
  if (!draft) return ""
  const {
    runtime: _runtime,
    updatedAt: _updatedAt,
    lastInitialization: _last,
    initializationHistory: _history,
    ...rest
  } = draft
  return JSON.stringify({ rest, variables, secrets, isDefault })
}

/** How many per-OS overrides hold a script. */
function overrideCount(script: ProjectEnvironmentScript): number {
  return OSES.filter((os) => script.byOs?.[os]?.trim()).length
}

/**
 * A script and its per-OS overrides.
 *
 * The overrides are folded away by default: they replace the script above on
 * one operating system (`executor.ts`), which most environments never need,
 * and three always-open inputs under every script made each action read as
 * four scripts. The fold says how many are set, so a set one is never hidden
 * without a trace. Native `<details>`, so the fields stay in the document and
 * are reachable by find-in-page and by label.
 */
function ScriptFields({
  value,
  onChange,
  ids,
  label,
}: {
  value: ProjectEnvironmentScript
  onChange(value: ProjectEnvironmentScript): void
  ids: string
  label: string
}) {
  const t = useTranslations("projectEnvironment")
  const updateOs = (os: (typeof OSES)[number], script: string) =>
    onChange({ ...value, byOs: { ...value.byOs, [os]: script } })
  const count = overrideCount(value)
  return (
    <div className="space-y-2">
      <Textarea
        id={`${ids}-default`}
        value={value.default}
        onChange={(event) => onChange({ ...value, default: event.target.value })}
        placeholder={t("setupPlaceholder")}
        aria-label={label}
        className="min-h-20 font-mono text-xs"
      />
      <details className="group/os">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-3 transition-transform group-open/os:rotate-90"
          />
          {t("osOverrides")}
          <span className="tabular-nums">· {t("osOverridesCount", { count })}</span>
        </summary>
        <div className="mt-2 space-y-2 border-l-2 pl-3">
          <p className="text-[11px] leading-snug text-muted-foreground">{t("osOverridesHint")}</p>
          <div className="grid gap-2 @xl/environment-card:grid-cols-3">
            {OSES.map((os) => (
              <div key={os} className="min-w-0 space-y-1">
                <Label htmlFor={`${ids}-${os}`} className="text-[11px] font-normal">
                  {t(os)}
                </Label>
                <Input
                  id={`${ids}-${os}`}
                  value={value.byOs?.[os] ?? ""}
                  onChange={(event) => updateOs(os, event.target.value)}
                  placeholder={t(os)}
                  className="font-mono text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  )
}

/** A line the repository's configuration adds to a section, stated where it bites. */
function RepoNotice({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p
      className="mb-3 flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400"
      data-testid={testId}
    >
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/**
 * A label-left, control-right setting, with its explanation under the label
 * and tied to the control (`aria-describedby`) rather than inside its name.
 */
function SettingLine({
  id,
  label,
  hint,
  control,
}: {
  id: string
  label: string
  hint: string
  control: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <p id={`${id}-hint`} className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {hint}
        </p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  )
}

type PendingSwitch = { kind: "select"; id: string } | { kind: "create" } | { kind: "discard-new" }

export function ProjectEnvironmentManager({
  projectId,
  executionRoot,
  scope,
  selectedEnvironmentId,
  onSelectedEnvironmentChange,
}: {
  projectId: string
  executionRoot: string
  scope: "local" | "managedWorktree"
  selectedEnvironmentId?: string
  onSelectedEnvironmentChange?(environmentId: string | undefined): Promise<void> | void
}) {
  const t = useTranslations("projectEnvironment")
  const tRepo = useTranslations("projectEnvironment.repoConfig")
  const tRuntime = useTranslations("projectEnvironment.runtime")
  const tBootstrap = useTranslations("projectEnvironment.bootstrap")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const ids = useId()

  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([])
  const [loadState, setLoadState] = useState<{
    status: "loading" | "ready" | "error"
    error?: string
  }>({ status: "loading" })
  const [reloadToken, setReloadToken] = useState(0)
  const [draft, setDraft] = useState<ProjectEnvironment | null>(null)
  const [variables, setVariables] = useState<VariableRow[]>([])
  const [secrets, setSecrets] = useState<SecretRow[]>([])
  const [isDefault, setIsDefault] = useState(false)
  /** The snapshot the working copy was loaded from; dirty is "differs from this". */
  const [baseline, setBaseline] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const defaultEnvironmentId = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.defaultEnvironmentId
  )
  // One read of the repository's verdict for the whole panel: the repository
  // section shows it, and the editor needs it to say what the repository
  // replaces.
  const repoConfig = useRepoWorkspaceConfig(projectId, executionRoot)

  const selectDraft = useCallback(
    (environment: ProjectEnvironment | null) => {
      // A stored row can be missing collections the type declares as always
      // present (see `hydrateProjectEnvironment`). The panel reads
      // `draft.actions`, `variables` and `keyringReferences` during render, so
      // one missing array used to throw and blank the page rather than showing
      // an environment with an empty list. Normalise once, here, rather than
      // guarding at each of the eight read sites.
      const hydrated = environment ? hydrateProjectEnvironment(structuredClone(environment)) : null
      const nextVariables = Object.entries(hydrated?.variables ?? {}).map(([name, value]) => ({
        name,
        value,
      }))
      const nextSecrets = (hydrated?.keyringReferences ?? []).map((reference) => ({
        ...reference,
      }))
      const nextDefault = Boolean(environment && environment.id === defaultEnvironmentId)
      setDraft(hydrated)
      setVariables(nextVariables)
      setSecrets(nextSecrets)
      setIsDefault(nextDefault)
      setBaseline(editorSnapshot(hydrated, nextVariables, nextSecrets, nextDefault))
      setMessage(null)
    },
    [defaultEnvironmentId]
  )

  const isStored = Boolean(draft && environments.some((row) => row.id === draft.id))
  const dirty = useMemo(
    () => Boolean(draft) && editorSnapshot(draft, variables, secrets, isDefault) !== baseline,
    [baseline, draft, isDefault, secrets, variables]
  )

  /**
   * What the background reload needs to know about the editor. Kept in a ref,
   * written after each commit, so the reload effect does not re-run (and
   * re-read IndexedDB) on every keystroke.
   */
  const editorRef = useRef<{ id: string | null; dirty: boolean; stored: boolean }>({
    id: null,
    dirty: false,
    stored: false,
  })
  useEffect(() => {
    editorRef.current = { id: draft?.id ?? null, dirty, stored: isStored }
  }, [draft?.id, dirty, isStored])
  /** The props the last load ran with, to tell "the session switched" from a reload. */
  const lastLoad = useRef<{ projectId: string; selectedEnvironmentId?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const previous = lastLoad.current
    const sameProject = previous?.projectId === projectId
    const selectionMoved = !sameProject || previous?.selectedEnvironmentId !== selectedEnvironmentId
    lastLoad.current = { projectId, selectedEnvironmentId }
    void listProjectEnvironments(projectId)
      .then((rows) => {
        if (cancelled) return
        setEnvironments(rows)
        setLoadState({ status: "ready" })
        const editor = editorRef.current
        // A reload behind the editor (the default moved, a retry) keeps what
        // is being edited, and keeps unsaved edits outright. Only a change of
        // project, or the session choosing another environment, moves it.
        if (sameProject && !selectionMoved && editor.id) {
          // Unsaved edits, and a definition that was never saved, stay as they are.
          if (editor.dirty || !editor.stored) return
          const current = rows.find((row) => row.id === editor.id)
          if (current) {
            selectDraft(current)
            return
          }
        }
        selectDraft(rows.find((row) => row.id === selectedEnvironmentId) ?? rows[0] ?? null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setEnvironments([])
        setLoadState({
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
    return () => {
      cancelled = true
    }
    // The default id is intentionally included so the default switch follows project updates.
  }, [projectId, selectedEnvironmentId, defaultEnvironmentId, selectDraft, reloadToken])

  const load = async (preferredId = selectedEnvironmentId) => {
    const rows = await listProjectEnvironments(projectId)
    setEnvironments(rows)
    setLoadState({ status: "ready" })
    const selected = rows.find((row) => row.id === preferredId) ?? rows[0] ?? null
    selectDraft(selected)
  }

  const retryLoad = () => {
    setLoadState({ status: "loading" })
    setReloadToken((token) => token + 1)
  }

  // ------------------------------------------------------------ switching

  const applySwitch = (target: PendingSwitch) => {
    if (target.kind === "create") selectDraft(emptyEnvironment(projectId))
    else if (target.kind === "discard-new") selectDraft(environments[0] ?? null)
    else selectDraft(environments.find((row) => row.id === target.id) ?? null)
  }

  /** Every way the working copy can be replaced goes through here. */
  const requestSwitch = (target: PendingSwitch) => {
    if (target.kind === "select" && target.id === draft?.id) return
    if (dirty) setPendingSwitch(target)
    else applySwitch(target)
  }

  const discardEdits = () => {
    if (!draft) return
    if (!isStored) {
      requestSwitch({ kind: "discard-new" })
      return
    }
    selectDraft(environments.find((row) => row.id === draft.id) ?? null)
  }

  // -------------------------------------------------------------- writes

  const save = async () => {
    if (!draft?.name.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const stamp = Date.now()
      const { setupReuse: _draftReuse, bootstrapAgent: _draftBootstrap, ...rest } = draft
      const setupReuse = finalizeSetupReuse(draft.setupReuse)
      const next: ProjectEnvironment = {
        ...rest,
        ...(setupReuse ? { setupReuse } : {}),
        ...(draft.bootstrapAgent ? { bootstrapAgent: draft.bootstrapAgent } : {}),
        name: draft.name.trim(),
        variables: plainVariables(variables),
        keyringReferences: keyringReferences(secrets),
        updatedAt: stamp,
      }
      assertBootstrapEnvironment(next)
      await putProjectEnvironment(next)
      useProjectStore.getState().updateProject(projectId, {
        defaultEnvironmentId: isDefault
          ? next.id
          : defaultEnvironmentId === next.id
            ? undefined
            : defaultEnvironmentId,
      })
      await onSelectedEnvironmentChange?.(next.id)
      await load(next.id)
      setMessage({ kind: "success", text: t("saved") })
    } catch (cause) {
      setMessage({
        kind: "error",
        text: t("failure", {
          message:
            cause instanceof BootstrapAgentValidationError
              ? t(`bootstrap.validation.${cause.code}`)
              : cause instanceof Error
                ? cause.message
                : String(cause),
        }),
      })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!draft) return
    setBusy(true)
    setMessage(null)
    try {
      await deleteProjectEnvironment(draft.id)
      if (defaultEnvironmentId === draft.id) {
        useProjectStore.getState().updateProject(projectId, { defaultEnvironmentId: undefined })
      }
      if (selectedEnvironmentId === draft.id) await onSelectedEnvironmentChange?.(undefined)
      await load(undefined)
      setMessage({ kind: "success", text: t("deleted") })
    } catch (cause) {
      setMessage({
        kind: "error",
        text: t("deleteFailed", {
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      })
    } finally {
      setBusy(false)
    }
  }

  const execute = async (actionId?: string, bypassOnFailure = false) => {
    if (!draft) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await executeProjectEnvironment({
        environment: {
          ...draft,
          variables: plainVariables(variables),
          keyringReferences: keyringReferences(secrets),
        },
        executionRoot,
        scope,
        surface: "interactive",
        actionId,
        bypassOnFailure,
        // Pressing "Run setup" means run it: never answered by a reused or
        // in-flight setup, and it records a fresh success for later reuse.
        force: actionId === undefined,
      })
      setMessage(
        result.success
          ? { kind: "success", text: t("success") }
          : {
              kind: "error",
              text: t("failure", {
                message: result.bootstrapValidationCode
                  ? t(`bootstrap.validation.${result.bootstrapValidationCode}`)
                  : (result.error ?? "unknown"),
              }),
            }
      )
      // A run records its result on the stored row. Refresh the list (its
      // status dots) and, when nothing is being edited, the working copy; an
      // edited one keeps the user's edits and only the list moves.
      if (!result.bootstrapValidationCode) {
        if (dirty) {
          const rows = await listProjectEnvironments(projectId)
          setEnvironments(rows)
        } else {
          await load(draft.id)
        }
      }
    } catch (cause) {
      setMessage({
        kind: "error",
        text: t("failure", { message: cause instanceof Error ? cause.message : String(cause) }),
      })
    } finally {
      setBusy(false)
    }
  }

  const updateAction = (index: number, action: ProjectEnvironmentAction) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            actions: current.actions.map((item, itemIndex) =>
              itemIndex === index ? action : item
            ),
          }
        : current
    )

  // ---------------------------------------------- the repository, applied

  const applied = repoConfig.verdict.kind === "approved" ? repoConfig.verdict.config : null
  const merged = useMemo(
    () =>
      applied && draft
        ? mergeWorkspaceConfig(
            {
              ...draft,
              variables: plainVariables(variables),
              keyringReferences: keyringReferences(secrets),
            },
            applied
          )
        : null,
    [applied, draft, secrets, variables]
  )

  const storedDraft = draft ? environments.find((row) => row.id === draft.id) : undefined
  const lastRun = draft?.lastInitialization
  const draftLabel = draft?.name.trim() || t("unnamed")

  // ---------------------------------------------------------------- view

  return (
    <section
      className="@container/environment-pane min-w-0"
      data-testid="project-environment-manager"
      aria-labelledby={`${ids}-title`}
    >
      <header className="mb-5">
        <h2 id={`${ids}-title`} className="text-sm font-semibold">
          {t("title")}
        </h2>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t("description")}</p>
      </header>

      {/* What the repository ships, then what a worktree needs: the stronger
          statements, which the local environment is merged on top of. */}
      <div className="mb-8 grid items-start gap-x-8 gap-y-7 @3xl/environment-pane:grid-cols-2">
        <ProjectEnvironmentSection id="repo-config" title={tRepo("title")}>
          <ProjectEnvironmentRepoConfigView state={repoConfig} />
        </ProjectEnvironmentSection>
        <ProjectEnvironmentProvisioning projectId={projectId} executionRoot={executionRoot} />
      </div>

      <div className="grid items-start gap-x-8 gap-y-7 @3xl/environment-pane:grid-cols-[14rem_minmax(0,1fr)]">
        {/* Sticky beside a long editor on a wide pane, so switching does not
            mean scrolling back up to the list. */}
        <ProjectEnvironmentSection
          id="environments"
          title={t("listTitle")}
          meta={loadState.status === "ready" ? environments.length : undefined}
          className="@3xl/environment-pane:sticky @3xl/environment-pane:top-0"
        >
          <ProjectEnvironmentList
            environments={environments}
            status={loadState.status}
            error={loadState.error}
            selectedId={draft?.id ?? null}
            unsaved={draft && !isStored ? { id: draft.id, name: draft.name } : null}
            defaultEnvironmentId={defaultEnvironmentId}
            onSelect={(id) => requestSwitch({ kind: "select", id })}
            onCreate={() => requestSwitch({ kind: "create" })}
            onRetry={retryLoad}
            disabled={busy}
          />
        </ProjectEnvironmentSection>

        {draft ? (
          <div className="min-w-0 space-y-7" data-testid="project-environment-editor">
            <ProjectEnvironmentSection id="general" title={t("select")}>
              <div className="space-y-1">
                <Label htmlFor={`${ids}-name`} className="text-xs">
                  {t("name")}
                </Label>
                <Input
                  id={`${ids}-name`}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder={t("unnamed")}
                  aria-invalid={!draft.name.trim() && dirty ? true : undefined}
                />
              </div>
              <div className="mt-1 divide-y">
                <SettingLine
                  id={`${ids}-enabled`}
                  label={t("enabled")}
                  hint={t("enabledHint")}
                  control={
                    <Switch
                      id={`${ids}-enabled`}
                      aria-describedby={`${ids}-enabled-hint`}
                      checked={draft.isEnabled}
                      onCheckedChange={(checked) => setDraft({ ...draft, isEnabled: checked })}
                    />
                  }
                />
                <SettingLine
                  id={`${ids}-default`}
                  label={t("default")}
                  hint={t("defaultHint")}
                  control={
                    <Checkbox
                      id={`${ids}-default`}
                      aria-describedby={`${ids}-default-hint`}
                      checked={isDefault}
                      onCheckedChange={(checked) => setIsDefault(Boolean(checked))}
                    />
                  }
                />
              </div>
              <div className="border-t pt-2.5" data-testid="project-environment-last-run">
                <p className="text-[11px] text-muted-foreground">
                  {lastRun
                    ? t("lastRun", {
                        status: t(`initStatus.${lastRun.status}`),
                        time: format.relativeTime(
                          new Date(lastRun.completedAt ?? lastRun.startedAt),
                          now
                        ),
                      })
                    : t("lastRunNever")}
                </p>
                {lastRun?.status === "failed" && lastRun.error ? (
                  <p className="mt-1 break-words font-mono text-[11px] text-destructive">
                    {lastRun.error}
                  </p>
                ) : null}
              </div>
            </ProjectEnvironmentSection>

            <ProjectEnvironmentSection id="setup" title={t("setup")}>
              {applied ? (
                <RepoNotice testId="project-environment-repo-replaces-setup">
                  {t("repoReplacesSetup")}
                </RepoNotice>
              ) : null}
              <ScriptFields
                value={draft.setupScript}
                onChange={(setupScript) => setDraft({ ...draft, setupScript })}
                ids={`${ids}-setup`}
                label={t("setup")}
              />
              <div className="mt-4 border-t pt-3">
                <ProjectEnvironmentSetupReuseFields
                  value={draft.setupReuse}
                  onChange={(setupReuse) => setDraft({ ...draft, setupReuse })}
                  ids={`${ids}-reuse`}
                />
              </div>
            </ProjectEnvironmentSection>

            <ProjectEnvironmentSection id="bootstrap" title={tBootstrap("title")}>
              <ProjectEnvironmentBootstrap
                value={draft.bootstrapAgent}
                onChange={(bootstrapAgent) => setDraft({ ...draft, bootstrapAgent })}
                onApplyRecipe={({ bootstrapAgent, setupScript }) =>
                  setDraft({ ...draft, bootstrapAgent, setupScript })
                }
                ids={`${ids}-bootstrap`}
              />
            </ProjectEnvironmentSection>

            <ProjectEnvironmentSection
              id="variables"
              title={t("variables")}
              description={t("plainWarning")}
              meta={variables.length || undefined}
            >
              {merged && merged.overriddenVariables.length > 0 ? (
                <RepoNotice testId="project-environment-overridden-variables">
                  {tRepo("overriddenVariables", { names: merged.overriddenVariables.join(", ") })}
                </RepoNotice>
              ) : null}
              <ul className="space-y-2">
                {variables.map((row, index) => (
                  <li
                    key={index}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5 @md/environment-card:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"
                  >
                    <Input
                      value={row.name}
                      aria-label={t("variableName")}
                      placeholder={t("variableName")}
                      className="font-mono text-xs"
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, name: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Input
                      value={row.value}
                      aria-label={t("variableValue")}
                      placeholder={t("variableValue")}
                      className="col-start-1 row-start-2 font-mono text-xs @md/environment-card:col-start-2 @md/environment-card:row-start-1"
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, value: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="col-start-2 row-start-1 @md/environment-card:col-start-3"
                      aria-label={t("remove")}
                      onClick={() =>
                        setVariables((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index)
                        )
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                className={cn("-ml-2", variables.length > 0 && "mt-2")}
                onClick={() => setVariables((current) => [...current, { name: "", value: "" }])}
              >
                <PlusIcon className="size-3.5" />
                {t("addVariable")}
              </Button>
            </ProjectEnvironmentSection>

            <ProjectEnvironmentSection
              id="secrets"
              title={t("secrets")}
              meta={secrets.length || undefined}
            >
              {merged && merged.missingSecretVariables.length > 0 ? (
                <RepoNotice testId="project-environment-missing-secrets">
                  {tRepo("missingSecrets", { names: merged.missingSecretVariables.join(", ") })}
                </RepoNotice>
              ) : null}
              <ul className="space-y-2">
                {secrets.map((row, index) => (
                  <li
                    key={index}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5 @md/environment-card:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"
                  >
                    <Input
                      value={row.variable}
                      aria-label={t("secretVariable")}
                      placeholder={t("secretVariable")}
                      className="font-mono text-xs"
                      onChange={(event) =>
                        setSecrets((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, variable: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Input
                      value={row.keyringRef}
                      aria-label={t("secretReference")}
                      placeholder={t("secretReference")}
                      className="col-start-1 row-start-2 font-mono text-xs @md/environment-card:col-start-2 @md/environment-card:row-start-1"
                      onChange={(event) =>
                        setSecrets((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, keyringRef: event.target.value } : item
                          )
                        )
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="col-start-2 row-start-1 @md/environment-card:col-start-3"
                      aria-label={t("remove")}
                      onClick={() =>
                        setSecrets((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index)
                        )
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                className={cn("-ml-2", secrets.length > 0 && "mt-2")}
                onClick={() =>
                  setSecrets((current) => [...current, { variable: "", keyringRef: "" }])
                }
              >
                <PlusIcon className="size-3.5" />
                {t("addSecret")}
              </Button>
            </ProjectEnvironmentSection>

            <ProjectEnvironmentSection
              id="actions"
              title={t("actions")}
              meta={draft.actions.length || undefined}
            >
              {applied ? (
                <RepoNotice testId="project-environment-repo-replaces-actions">
                  {t("repoReplacesActions")}
                </RepoNotice>
              ) : null}
              {draft.actions.length > 0 ? (
                <ul className="divide-y border-y">
                  {draft.actions.map((action, index) => (
                    <li key={action.id} className="space-y-2 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Input
                          value={action.name}
                          aria-label={t("actionName")}
                          placeholder={t("actionName")}
                          className="h-8 min-w-0 flex-1 basis-40"
                          onChange={(event) =>
                            updateAction(index, { ...action, name: event.target.value })
                          }
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void execute(action.id)}
                        >
                          {t("runAction", { name: action.name || t("actionName") })}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("remove")}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              actions: draft.actions.filter((_, itemIndex) => itemIndex !== index),
                            })
                          }
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                      <ScriptFields
                        value={action.script}
                        onChange={(script) => updateAction(index, { ...action, script })}
                        ids={`${ids}-action-${action.id}`}
                        label={t("actionScript")}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className={cn("-ml-2", draft.actions.length > 0 && "mt-2")}
                onClick={() =>
                  setDraft({
                    ...draft,
                    actions: [
                      ...draft.actions,
                      {
                        id: `action:${crypto.randomUUID()}`,
                        name: "",
                        script: { default: "", byOs: {} },
                      },
                    ],
                  })
                }
              >
                <PlusIcon className="size-3.5" />
                {t("addAction")}
              </Button>
            </ProjectEnvironmentSection>

            {/* Its own save, and it writes only `runtime`: the stored row is
                what it starts from, so it cannot publish the unsaved edits
                above, and the draft is told the new selection so a later save
                here does not write the old one back. Only a host that runs the
                sandbox pool can act on a selection (ADR-0182), so anywhere
                else the gate says why instead of offering one. */}
            <ProjectEnvironmentSection
              id="runtime"
              title={tRuntime("title")}
              description={tRuntime("description")}
              meta={tRuntime("savedSeparately")}
            >
              <CapabilityGate capability="sandbox-pool" explain>
                <ProjectEnvironmentRuntime
                  projectId={projectId}
                  executionRoot={executionRoot}
                  environment={storedDraft}
                  onRuntimeSaved={(runtime) => {
                    const apply = <T extends ProjectEnvironment>(row: T): T => {
                      const { runtime: _previous, ...rest } = row
                      return (runtime ? { ...rest, runtime } : rest) as T
                    }
                    setEnvironments((rows) =>
                      rows.map((row) => (row.id === draft.id ? apply(row) : row))
                    )
                    setDraft((current) =>
                      current && current.id === draft.id ? apply(current) : current
                    )
                  }}
                />
              </CapabilityGate>
            </ProjectEnvironmentSection>

            {/* A rule of the runs, not a verb: it sits with the form rather
                than taking a line of the bar on every screen. */}
            <p className="text-[11px] text-muted-foreground">{t("scheduledNoBypass")}</p>

            {/*
              The editor's verbs, kept at the bottom of the scroll while the
              form is on screen. Status and dirty state lead, so what the
              buttons will act on is said beside them. On a narrow pane the
              secondary verbs give up their words (keeping their names for
              assistive tech) so the bar stays two short lines instead of
              wrapping to four over the form it serves.
            */}
            <div
              className="sticky bottom-0 z-10 -mx-1 border-t bg-background px-1 pt-2 pb-2.5"
              data-testid="project-environment-actions"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="min-w-0 basis-full @2xl/environment-pane:flex-1 @2xl/environment-pane:basis-0">
                  {message ? (
                    <p
                      role={message.kind === "error" ? "alert" : "status"}
                      className={cn(
                        "line-clamp-3 break-words text-xs",
                        message.kind === "error"
                          ? "text-destructive"
                          : "text-emerald-600 dark:text-emerald-400"
                      )}
                      title={message.text}
                    >
                      {message.text}
                    </p>
                  ) : !isStored ? (
                    <p
                      className="truncate text-xs text-muted-foreground"
                      data-testid="project-environment-unsaved"
                    >
                      {draft.name.trim() ? t("newUnsaved") : t("nameRequired")}
                    </p>
                  ) : dirty ? (
                    <p
                      className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                      data-testid="project-environment-unsaved"
                    >
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
                      {t("unsaved")}
                    </p>
                  ) : null}
                </div>
                <div className="flex w-full items-center gap-1 @2xl/environment-pane:w-auto">
                  {isStored ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2 text-destructive hover:text-destructive"
                      aria-label={t("delete")}
                      title={t("delete")}
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2Icon className="size-3.5" />
                      <span className="hidden @2xl/environment-pane:inline">{t("delete")}</span>
                    </Button>
                  ) : null}
                  {dirty || !isStored ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2"
                      aria-label={t("discard")}
                      title={t("discard")}
                      disabled={busy}
                      onClick={discardEdits}
                    >
                      <Undo2Icon className="size-3.5" />
                      <span className="hidden @2xl/environment-pane:inline">{t("discard")}</span>
                    </Button>
                  ) : null}
                  <div className="ml-auto flex items-center gap-1.5">
                    {lastRun?.status === "failed" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void execute(undefined, true)}
                      >
                        {t("bypass")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void execute()}
                    >
                      {lastRun?.status === "failed" ? t("retry") : t("runSetup")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !draft.name.trim()}
                      onClick={() => void save()}
                    >
                      {t("save")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : loadState.status === "ready" && (environments.length > 0 || message) ? (
          // Only when there is something to pick: with no environments at
          // all, the list's own empty state already says what to do, and a
          // second "nothing here" beside it was the same sentence twice.
          <div className="py-1" data-testid="project-environment-editor-empty">
            {environments.length > 0 ? (
              <>
                <p className="text-xs font-medium">{t("none")}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t("editorEmptyBody")}</p>
              </>
            ) : null}
            {message ? (
              <p
                role={message.kind === "error" ? "alert" : "status"}
                className={cn(
                  "mt-2 text-xs",
                  message.kind === "error"
                    ? "text-destructive"
                    : "text-emerald-600 dark:text-emerald-400"
                )}
              >
                {message.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={pendingSwitch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSwitch(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("discardBody", { name: draftLabel })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("keepEditing")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingSwitch) applySwitch(pendingSwitch)
                setPendingSwitch(null)
              }}
            >
              {t("discardConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle", { name: draftLabel })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false)
                void remove()
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
