"use client"

/**
 * Context bar — the fused strip on the welcome composer's top edge.
 *
 * Variant D of the exploration, kept: every visible token IS its control,
 * no expand step. The sentence reads left to right as the execution context
 * a new conversation gets:
 *
 *   environment   ProjectEnvironment definition       (left)
 *   repository    workspace root + local checkout      (left)
 *   worktree      off | auto-named | manually named    (left)
 *   IM notify     bell toggle + "…" form panel         (right)
 *
 * No project picker: the sidebar's top-left workspace switcher already owns
 * that — a chat belongs to the workspace it was opened in.
 *
 * Wiring, all real:
 *   • env/root/location/base/name feed `useNewChatExecution` → session
 *     `create()` args (`environmentId`, `rootId`, `executionLocation`,
 *     `executionBase`, `worktreeName`).
 *   • the branch list calls `gitCheckoutBranch` for real in local mode.
 *   • the bell/“…“ panel read+write `useImNotifyStore`; armed sessions are
 *     pushed through `notifyConversationOverIM` by `ImNotifyInitializer`.
 */

import { WebSessionStatus } from "@/components/shell/web-status"
import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  LaptopIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { GitRefSelect } from "@/components/source-control/git-ref-select"
import { requestWorkspaceDialog } from "@/lib/workspace/workspace-dialog-request"
import { listProjectEnvironments } from "@/lib/db/project-environments"
import { gitBranches, gitCheckoutBranch, gitRefs } from "@/lib/git/commands"
import { primaryRootOf } from "@/lib/workspace/roots"
import {
  listNotifyConversations,
  useImNotifyStore,
  type NotifyConversation,
} from "@/stores/chat/im-notify-store"
import { cn } from "@/lib/utils"
import type { GitBranch, GitRef } from "@/types/git"
import type { Project } from "@/types"
import type { ProjectEnvironment } from "@/types/project-environment"
import type { SessionWorkspaceBaseSpec } from "@/types/execution-context"
import type { NewChatExecutionSelection } from "@/components/chat/new-chat-execution-picker"
import type { ImNotifyEvent } from "@/stores/chat/im-notify-store"

/** Shown while the git bridge is absent (plain `pnpm dev` in a browser). */
const MOCK_BRANCHES = ["dev", "main"]

const NO_BRANCHES: GitBranch[] = []
const NO_REFS: GitRef[] = []
const NO_ENVS: ProjectEnvironment[] = []

const NOTIFY_EVENTS: readonly ImNotifyEvent[] = ["done", "error", "attention"]

// ---------------------------------------------------------------------------

interface ContextBarModel {
  /** Local (non-remote) branch names; mock fallback off-bridge. */
  localBranches: string[]
  /** The checkout's current branch, or the first mock entry. */
  currentBranch: string | null
  /** Switch the checkout to another local branch — a real `git checkout`. */
  checkoutBranch: (name: string) => void
  /** All refs for the worktree gitRef base picker. */
  refs: GitRef[]
  /** Bound IM conversations for the notify channel picker. */
  conversations: NotifyConversation[]
  /** Enabled ProjectEnvironment definitions of the active workspace. */
  environments: ProjectEnvironment[]
}

function useContextBarData(
  project: Project | undefined,
  /** Path of the root the selection currently points at. */
  selectedRootPath: string | undefined
): ContextBarModel {
  // Fetched data is keyed by the owner it belongs to — a root/project switch
  // never flashes the previous owner's entries while the refetch is in flight.
  const [rootData, setRootData] = useState<{
    path: string
    branches: GitBranch[]
    refs: GitRef[]
  } | null>(null)
  const [envData, setEnvData] = useState<{
    projectId: string
    list: ProjectEnvironment[]
  } | null>(null)
  const [conversations, setConversations] = useState<NotifyConversation[]>([])

  useEffect(() => {
    if (!selectedRootPath) return
    let alive = true
    void Promise.all([gitBranches(selectedRootPath), gitRefs(selectedRootPath)]).then(
      ([branchList, refList]) => {
        if (alive) setRootData({ path: selectedRootPath, branches: branchList, refs: refList })
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [selectedRootPath])

  const projectId = project?.id
  useEffect(() => {
    if (!projectId) return
    let alive = true
    void listProjectEnvironments(projectId).then(
      (list) => {
        if (alive)
          setEnvData({
            projectId,
            list: list.filter((env) => env.isEnabled !== false),
          })
      },
      () => {
        if (alive) setEnvData({ projectId, list: [] })
      }
    )
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(() => {
    let alive = true
    void listNotifyConversations().then(
      (list) => {
        if (alive) setConversations(list)
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])

  const branches =
    rootData !== null && rootData.path === selectedRootPath ? rootData.branches : NO_BRANCHES
  const refs = rootData !== null && rootData.path === selectedRootPath ? rootData.refs : NO_REFS
  const environments = envData !== null && envData.projectId === projectId ? envData.list : NO_ENVS

  const localBranches = useMemo(() => {
    const names = branches.filter((b) => !b.isRemote).map((b) => b.name)
    return names.length > 0 ? names : MOCK_BRANCHES
  }, [branches])
  const currentBranch = branches.find((b) => b.isCurrent)?.name ?? localBranches[0] ?? null

  const checkoutBranch = (name: string) => {
    if (!selectedRootPath || name === currentBranch) return
    const path = selectedRootPath
    void gitCheckoutBranch(path, name)
      .then(() => gitBranches(path))
      .then((list) =>
        setRootData((prev) => ({
          path,
          branches: list,
          refs: prev?.path === path ? prev.refs : [],
        }))
      )
      .catch(() => undefined)
  }

  return { localBranches, currentBranch, checkoutBranch, refs, conversations, environments }
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

/** Chip-quiet trigger for the Selects: no border, muted text, hover fill. */
const CHIP_TRIGGER =
  "h-7 w-auto min-w-0 gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-normal text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground focus-visible:ring-1 dark:bg-transparent dark:hover:bg-muted/60 [&_svg]:size-3.5"

type Translate = (key: string, values?: Record<string, string | number | Date>) => string

interface ControlProps {
  model: ContextBarModel
  project: Project
  execution: NewChatExecutionSelection
  onExecutionChange: (value: NewChatExecutionSelection) => void
  t: Translate
  tExec: Translate
  /** Platform display names — `inbox.platformBadge.names`, keyed by PlatformKind. */
  tPlatform: Translate
}

/** A worktree name is a Git branch name — same ruleset the host enforces. */
function validateWorktreeName(name: string): boolean {
  if (!name || name.startsWith("-")) return false
  return !(
    /[\x00-\x20]/.test(name) ||
    name.includes("..") ||
    name.includes("~") ||
    name.includes("^") ||
    name.includes(":") ||
    name.includes("?") ||
    name.includes("*") ||
    name.includes("[") ||
    name.includes("\\") ||
    name.endsWith("/") ||
    name.endsWith(".lock")
  )
}

// ---------------------------------------------------------------------------
// 环境 — the ProjectEnvironment the chat runs under.
// ---------------------------------------------------------------------------

const ENV_DEFAULT = "__default__"
const ENV_NONE = "__none__"

function EnvSelect({ model, project, execution, onExecutionChange, t }: ControlProps) {
  const value =
    execution.environmentId === undefined
      ? ENV_DEFAULT
      : execution.environmentId === ""
        ? ENV_NONE
        : execution.environmentId
  const defaultEnv = model.environments.find((env) => env.id === project.defaultEnvironmentId)
  return (
    <Select
      value={value}
      onValueChange={(next) =>
        onExecutionChange({
          ...execution,
          environmentId: next === ENV_DEFAULT ? undefined : next === ENV_NONE ? "" : next,
        })
      }
    >
      <SelectTrigger
        size="sm"
        className={cn(CHIP_TRIGGER, "max-w-[11rem]")}
        aria-label={t("envLabel")}
        data-testid="ctxbar-env"
      >
        <LaptopIcon aria-hidden className="size-3.5 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={ENV_DEFAULT}>
          {defaultEnv ? t("envDefaultNamed", { name: defaultEnv.name }) : t("envDefault")}
        </SelectItem>
        <SelectItem value={ENV_NONE}>{t("envNone")}</SelectItem>
        {model.environments.map((env) => (
          <SelectItem key={env.id} value={env.id}>
            {env.name}
          </SelectItem>
        ))}
        {/* A pick whose environment was since deleted or disabled is still the
            selection — show the stale id (unselectable) rather than rendering
            the token as a blank or a phantom. */}
        {value !== ENV_DEFAULT &&
        value !== ENV_NONE &&
        !model.environments.some((env) => env.id === value) ? (
          <SelectItem value={value} disabled>
            {value}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// 仓库 — which workspace root, and (in local mode) which branch is checked out.
// ---------------------------------------------------------------------------

function RepoControl({ model, project, execution, onExecutionChange, t }: ControlProps) {
  const roots = project.roots
  const selectedRoot = roots.find((root) => root.id === execution.rootId) ?? primaryRootOf(project)
  const label = selectedRoot?.label ?? selectedRoot?.path.split("/").filter(Boolean).pop() ?? "—"
  // A single root in worktree mode has nothing to choose — the token degrades
  // to a passive label rather than opening an empty popover.
  if (roots.length <= 1 && execution.location !== "local") {
    return (
      <span
        className="flex h-7 max-w-[12rem] items-center gap-1.5 px-2 text-xs text-muted-foreground/70"
        data-testid="ctxbar-repo"
      >
        <FolderIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    )
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(CHIP_TRIGGER, "inline-flex max-w-[12rem] items-center")}
          aria-label={t("repoLabel")}
          data-testid="ctxbar-repo"
        >
          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64" data-testid="ctxbar-repo-panel">
        {roots.length > 1 ? (
          <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={t("repoLabel")}>
            {roots.map((root) => {
              const active = root.id === selectedRoot?.id
              return (
                <button
                  key={root.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() =>
                    onExecutionChange({
                      ...execution,
                      rootId: root.id === primaryRootOf(project)?.id ? undefined : root.id,
                    })
                  }
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/70"
                >
                  <CheckIcon
                    aria-hidden
                    className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">
                    {root.label ?? root.path.split("/").filter(Boolean).pop()}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
        {execution.location === "local" ? (
          <div className={cn("flex flex-col gap-0.5", roots.length > 1 && "mt-2 border-t pt-2")}>
            <span className="px-2 pb-0.5 text-[11px] text-muted-foreground">
              {t("currentBranch")}
            </span>
            {model.localBranches.map((name) => {
              const active = name === model.currentBranch
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => model.checkoutBranch(name)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/70"
                >
                  <CheckIcon
                    aria-hidden
                    className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">{name}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Worktree — off | auto-named | manually named, plus the base it starts from.
// ---------------------------------------------------------------------------

type WorktreeMode = "off" | "auto" | "manual"

function worktreeModeOf(execution: NewChatExecutionSelection): WorktreeMode {
  if (execution.location !== "managedWorktree") return "off"
  return execution.worktreeName !== undefined ? "manual" : "auto"
}

function WorktreeControl(props: ControlProps) {
  const { model, execution, onExecutionChange, tExec } = props
  const mode = worktreeModeOf(execution)
  const draft = execution.worktreeName ?? ""
  const nameProblem =
    mode === "manual" && draft.trim() !== "" && !validateWorktreeName(draft.trim())
      ? "invalid"
      : mode === "manual" && draft.trim() !== "" && model.localBranches.includes(draft.trim())
        ? "taken"
        : null

  const setMode = (next: WorktreeMode) => {
    if (next === "off") {
      const { worktreeName: _drop, ...rest } = execution
      onExecutionChange({ ...rest, location: "local" })
    } else if (next === "auto") {
      const { worktreeName: _drop, ...rest } = execution
      onExecutionChange({ ...rest, location: "managedWorktree" })
    } else {
      onExecutionChange({ ...execution, location: "managedWorktree", worktreeName: draft })
    }
  }

  const setBaseKind = (kind: SessionWorkspaceBaseSpec["kind"]) => {
    switch (kind) {
      case "workingState":
      case "localHead":
      case "remoteDefault":
        onExecutionChange({ ...execution, base: { kind } })
        break
      case "gitRef":
        onExecutionChange({
          ...execution,
          base: { kind, gitRef: model.refs[0]?.name ?? "HEAD" },
        })
        break
      case "pullRequest":
        onExecutionChange({
          ...execution,
          base: { kind, provider: "github", repo: "", number: 1 },
        })
        break
    }
  }

  const triggerLabel =
    mode === "off"
      ? tExec("worktreeOff")
      : mode === "auto"
        ? tExec("worktreeAuto")
        : draft.trim() || tExec("worktreeManual")

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            CHIP_TRIGGER,
            "inline-flex max-w-[12rem] items-center",
            mode !== "off" && "text-foreground"
          )}
          aria-label={tExec("worktree")}
          data-testid="ctxbar-worktree"
        >
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{triggerLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72" data-testid="ctxbar-worktree-panel">
        <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={tExec("worktree")}>
          {(
            [
              ["off", tExec("worktreeOff"), tExec("worktreeOffHint")],
              ["auto", tExec("worktreeAuto"), tExec("worktreeAutoHint")],
              ["manual", tExec("worktreeManual"), tExec("worktreeManualHint")],
            ] as const
          ).map(([value, label, hint]) => {
            const active = mode === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`ctxbar-worktree-${value}`}
                onClick={() => setMode(value)}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/70"
              >
                <CheckIcon
                  aria-hidden
                  className={cn("mt-0.5 size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")}
                />
                <span className="flex flex-col">
                  <span className="text-xs">{label}</span>
                  <span className="text-[11px] text-muted-foreground">{hint}</span>
                </span>
              </button>
            )
          })}
        </div>
        {mode === "manual" ? (
          <div className="mt-2 flex flex-col gap-1 border-t pt-2">
            <Input
              value={draft}
              onChange={(event) =>
                onExecutionChange({ ...execution, worktreeName: event.target.value })
              }
              aria-label={tExec("worktreeNameLabel")}
              placeholder={tExec("worktreeNamePlaceholder")}
              data-testid="ctxbar-worktree-name"
              className="h-8 text-xs"
            />
            {nameProblem === "invalid" ? (
              <p className="px-1 text-[11px] text-destructive">{tExec("worktreeNameInvalid")}</p>
            ) : null}
            {nameProblem === "taken" ? (
              <p className="px-1 text-[11px] text-destructive">{tExec("worktreeNameTaken")}</p>
            ) : null}
          </div>
        ) : null}
        {mode !== "off" ? (
          <div className="mt-2 flex flex-col gap-2 border-t pt-2">
            <span className="px-1 text-[11px] text-muted-foreground">{tExec("baseLabel")}</span>
            <Select value={execution.base.kind} onValueChange={setBaseKind}>
              <SelectTrigger
                size="sm"
                className="h-8 w-full text-xs"
                aria-label={tExec("baseLabel")}
                data-testid="ctxbar-base"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="workingState">{tExec("bases.workingState")}</SelectItem>
                <SelectItem value="localHead">{tExec("bases.localHead")}</SelectItem>
                <SelectItem value="remoteDefault">{tExec("bases.remoteDefault")}</SelectItem>
                <SelectItem value="gitRef">{tExec("bases.gitRef")}</SelectItem>
                <SelectItem value="pullRequest">{tExec("bases.pullRequest")}</SelectItem>
              </SelectContent>
            </Select>
            {execution.base.kind === "gitRef" ? (
              <GitRefSelect
                refs={model.refs}
                value={execution.base.gitRef}
                onValueChange={(gitRef) =>
                  onExecutionChange({ ...execution, base: { kind: "gitRef", gitRef } })
                }
                placeholder={tExec("gitRefPlaceholder")}
                ariaLabel={tExec("gitRefLabel")}
                testId="ctxbar-gitref"
                className="h-8 w-full text-xs"
              />
            ) : null}
            {execution.base.kind === "pullRequest" ? (
              <PrBaseEditor
                base={execution.base}
                onChange={(base) => onExecutionChange({ ...execution, base })}
                tExec={tExec}
              />
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function PrBaseEditor({
  base,
  onChange,
  tExec,
}: {
  base: Extract<SessionWorkspaceBaseSpec, { kind: "pullRequest" }>
  onChange: (base: SessionWorkspaceBaseSpec) => void
  tExec: Translate
}) {
  return (
    <div className="flex flex-col gap-2">
      <Input
        value={base.repo}
        onChange={(e) => onChange({ ...base, repo: e.target.value })}
        aria-label={tExec("repositoryLabel")}
        placeholder={tExec("repositoryPlaceholder")}
        className="h-8 text-xs"
      />
      <Input
        type="number"
        min={1}
        value={base.number}
        onChange={(e) => {
          const number = e.currentTarget.valueAsNumber
          if (Number.isInteger(number) && number > 0) onChange({ ...base, number })
        }}
        aria-label={tExec("pullRequestNumberLabel")}
        className="h-8 w-24 text-xs"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notify controls — backed by `useImNotifyStore`, not local state.
// ---------------------------------------------------------------------------

function NotifyToggle() {
  const t = useTranslations("chat.empty.contextBar")
  const enabled = useImNotifyStore((s) => s.enabled)
  const setEnabled = useImNotifyStore((s) => s.setEnabled)
  return (
    <button
      type="button"
      aria-label={t("notifyImDone")}
      aria-pressed={enabled}
      onClick={() => setEnabled(!enabled)}
      data-testid="ctxbar-notify"
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
    >
      {/* The state swap mounts a fresh icon element, so the ring/mute
          animation re-fires on every toggle — not just the click path, the
          "…" panel's Switch lands here too. */}
      {enabled ? (
        <BellIcon aria-hidden className="im-bell-ring size-3.5 shrink-0 text-primary" />
      ) : (
        <BellOffIcon aria-hidden className="im-bell-mute size-3.5 shrink-0" />
      )}
      <span className="whitespace-nowrap">{t("notifyIm")}</span>
    </button>
  )
}

/** Which bound IM conversation the ping lands in — `null` = auto. */
function NotifyChannelSelect({
  model,
  t,
  tPlatform,
}: Pick<ControlProps, "model" | "t" | "tPlatform">) {
  const enabled = useImNotifyStore((s) => s.enabled)
  const conversationKey = useImNotifyStore((s) => s.conversationKey)
  const setConversationKey = useImNotifyStore((s) => s.setConversationKey)
  return (
    <Select
      value={conversationKey ?? "auto"}
      onValueChange={(v) => setConversationKey(v === "auto" ? null : v)}
      disabled={!enabled || model.conversations.length === 0}
    >
      <SelectTrigger
        size="sm"
        className={CHIP_TRIGGER}
        aria-label={t("notifyChannel")}
        data-testid="ctxbar-notify-channel"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="auto">{t("notifyChannelAuto")}</SelectItem>
        {model.conversations.map((c) => (
          <SelectItem key={c.conversationKey} value={c.conversationKey}>
            {`${c.adapterName} · ${tPlatform(c.platform)}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const NOTIFY_EVENT_KEYS: Record<ImNotifyEvent, string> = {
  done: "notifyOn.done",
  error: "notifyOn.error",
  attention: "notifyOn.attention",
}

// ---------------------------------------------------------------------------

/** The labelled form-rows body inside the trailing "…" panel. Notify config
    does not need a checkout, so this takes the narrow slice it actually reads. */
function ContextPanelBody({
  model,
  t,
  tPlatform,
}: Pick<ControlProps, "model" | "t" | "tPlatform">) {
  const enabled = useImNotifyStore((s) => s.enabled)
  const setEnabled = useImNotifyStore((s) => s.setEnabled)
  const events = useImNotifyStore((s) => s.events)
  const toggleEvent = useImNotifyStore((s) => s.toggleEvent)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="w-20 shrink-0 text-xs text-muted-foreground">{t("notifyIm")}</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t("notifyImDone")} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="w-20 shrink-0 text-xs text-muted-foreground">{t("notifyChannel")}</span>
        <div className="flex min-w-0 flex-1 justify-end">
          <NotifyChannelSelect model={model} t={t} tPlatform={tPlatform} />
        </div>
      </div>
      {model.conversations.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          {t("notifyNoChannels")}
        </p>
      ) : null}
      {/* Three chips don't fit beside a left label — this row stacks. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{t("notifyWhen")}</span>
        <div
          role="group"
          aria-label={t("notifyWhen")}
          className={cn("flex flex-wrap gap-1", !enabled && "pointer-events-none opacity-50")}
        >
          {NOTIFY_EVENTS.map((event) => {
            const active = events[event]
            return (
              <Button
                key={event}
                type="button"
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className="h-6 px-2 text-xs"
                aria-pressed={active}
                disabled={!enabled}
                onClick={() => toggleEvent(event)}
              >
                {t(NOTIFY_EVENT_KEYS[event])}
              </Button>
            )
          })}
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">{t("appliesToNew")}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------

export interface ContextBarProps {
  execution: NewChatExecutionSelection
  onExecutionChange: (value: NewChatExecutionSelection) => void
  /** The active workspace; absent or rootless renders the open-folder hint. */
  project?: Project
}

export function ContextBar({ execution, onExecutionChange, project }: ContextBarProps) {
  const t = useTranslations("chat.empty.contextBar")
  const tExec = useTranslations("chat.empty.execution")
  const tPlatform = useTranslations("inbox.platformBadge.names")
  const tWorkspace = useTranslations("workspace")

  const selectedRoot = project
    ? (project.roots.find((root) => root.id === execution.rootId) ?? primaryRootOf(project))
    : undefined
  const model = useContextBarData(project, selectedRoot?.path)

  const shared: ControlProps | null =
    project && selectedRoot
      ? { model, project, execution, onExecutionChange, t, tExec, tPlatform }
      : null

  return (
    <>
      {/* The strip IS the card's top edge — scoped repairs make the two read
          as one surface (scope hook lives on the hero slot's container):
          1. the card's own top corners square off, or their radius peeks out
             as a notch at the seam;
          2. the card's top padding drops out — the strip provides that
             breathing room, so without this a dead band sits under the seam;
          3. the chip row under the seam hides when it holds nothing but
             display:none a11y live-regions — the stock `:empty` check misses
             them and leaves a stray ~8px row;
          4. when the card lights its border on focus-within the strip joins
             in, or the fused unit looks half-lit. */}
      <style>{`
[data-ctxbar-scope]:has([data-ctxbar-fused]) [data-composer-skin]{border-top-left-radius:0;border-top-right-radius:0;padding-top:0}
[data-ctxbar-scope]:has([data-ctxbar-fused]) [data-composer-skin]>[class*="self-start"]:not(:has([data-chip-flow]>:not([id^="Dnd"]))){display:none}
[data-ctxbar-scope]:focus-within [data-ctxbar-fused]{border-color:color-mix(in oklab,var(--primary) 40%,transparent)}
`}</style>
      <div
        data-testid="context-bar"
        data-ctxbar-fused
        data-tonality="translucent"
        className="relative z-10 -mb-px flex h-9 items-center gap-0.5 rounded-t-2xl border border-b-0 border-input/60 bg-background/70 px-1.5 transition-[border-color] duration-200"
      >
        {/* A rootless workspace has no checkout for the pickers to act on —
            offer the door to open one rather than dead controls. */}
        {shared ? (
          <>
            {/* Rendered whenever there is something to pick — OR a pick that
                no longer resolves (its env was deleted/disabled), so the stale
                choice stays visible and correctable rather than hiding the
                token while the stale id still rides into session creation. */}
            {model.environments.length > 0 ||
            (execution.environmentId !== undefined && execution.environmentId !== "") ? (
              <>
                <EnvSelect {...shared} />
                <span aria-hidden className="shrink-0 text-muted-foreground/40">
                  ·
                </span>
              </>
            ) : null}
            <RepoControl {...shared} />
            <span aria-hidden className="shrink-0 text-muted-foreground/40">
              ·
            </span>
            <WorktreeControl {...shared} />
          </>
        ) : (
          <>
            <span
              className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground/70"
              data-testid="ctxbar-managed-hint"
            >
              <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
              {tExec("worktree")}
            </span>
            <span aria-hidden className="shrink-0 text-muted-foreground/40">
              ·
            </span>
            {/* The pickers need a checkout — offer the door to open one. */}
            <button
              type="button"
              onClick={() => requestWorkspaceDialog("openFolder")}
              data-testid="ctxbar-open-folder"
              className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              {tWorkspace("switcher.openFolder")}
            </button>
          </>
        )}
        {/* The sentence tokens are the execution context; notify is a flag, so
            it parks with the overflow on the right rather than in the sentence. */}
        <WebSessionStatus host="context" />
        <div className="ms-auto flex shrink-0 items-center ps-1">
          <NotifyToggle />
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("moreOptions")}
                data-testid="ctxbar-more"
                className="flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <EllipsisIcon aria-hidden className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80" data-testid="ctxbar-panel">
              <ContextPanelBody model={model} t={t} tPlatform={tPlatform} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </>
  )
}
