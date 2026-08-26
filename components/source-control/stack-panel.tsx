"use client"

/**
 * The stacks in this repository, what is wrong with them, and the three things
 * that happen to a stack: it gets built, it gets published, it gets landed.
 *
 * # Why the problems are the content
 *
 * A stack that looks fine and is not is the failure this whole subsystem
 * exists to prevent: a layer that no longer contains its parent still
 * publishes, and its pull request quietly carries the layer below it. So the
 * panel's job is not "list your stacks" — it is to say, per stack, whether it
 * is safe and exactly what to do when it is not. The action button is the
 * remedy the validator chose, not a generic "fix".
 *
 * # No stack table
 *
 * Everything local is read from the parent pointers in the repository's own
 * Git config. A stack created in a terminal, or pulled from another machine,
 * is already here. Recording a parent from this panel writes the same config a
 * `git config` would, which is why the form is the whole "create a stack" flow.
 *
 * # The forge is opt-in
 *
 * Listing and validating stacks is local and cheap. Publishing shells out for
 * a credential and then makes one API call per branch, so nothing reaches
 * GitHub until Publish or Land is pressed. That is also why Restack pushes
 * only once this session has published something: force-pushing a stack is not
 * a side effect anybody should discover.
 */

import { useEffect, useState } from "react"
import {
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LayersIcon,
  Undo2Icon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { useStacks, type StackRow } from "@/hooks/git/use-stacks"
import { useStackForge, type StackForgeOutcome } from "@/hooks/git/use-stack-forge"
import { gitCreateBranch, gitIdentity } from "@/lib/git/commands"
import {
  DEFAULT_BRANCH_TEMPLATE,
  renderBranchName,
  type Stack,
  type StackPullRequest,
} from "@/lib/stack/model"
import { canRestack, type StackProblem } from "@/lib/stack/validate"
import { cn } from "@/lib/utils"
import { asGitError, type GitBranch, type GitIdentity } from "@/types/git"

interface StackPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  /** Local branches, for the "record a parent" form. */
  branches: GitBranch[]
  /** Injected in tests; production takes the hook's own defaults. */
  deps?: Parameters<typeof useStacks>[1]
  /** Same, for the half that talks to the forge. */
  forgeDeps?: Parameters<typeof useStackForge>[1]
  /** Commit identity, for the `{user}` half of a new layer's branch name. */
  identity?: (repoPath: string) => Promise<GitIdentity>
  createBranch?: typeof gitCreateBranch
}

function errorDetail(err: unknown): string {
  const payload = asGitError(err)
  if (payload?.detail) return payload.detail
  if (payload?.kind) return payload.kind
  return err instanceof Error ? err.message : String(err)
}

/** The message parameters each problem kind carries. */
function problemValues(problem: StackProblem): Record<string, string> {
  switch (problem.kind) {
    case "missingBranch":
      return { branch: problem.branch }
    case "behindParent":
      return { branch: problem.branch, parent: problem.parent }
    case "parentMismatch":
      return { branch: problem.branch, recorded: problem.recorded, expected: problem.expected }
    case "parentUnrecorded":
      return { branch: problem.branch, expected: problem.expected }
    case "checkedOut":
      return { branch: problem.branch, worktree: problem.worktree }
    case "forkOnly":
      return { repository: problem.repository }
  }
}

interface StackCardActions {
  onRestack: () => void
  onUnstack: (branch: string) => void
  onPublish: () => void
  onLand: () => void
  onUndo: (branch: string, historyRef: string) => void
}

function StackCard({
  row,
  busy,
  forgeBusy,
  willPush,
  pullRequests,
  actions,
}: {
  row: StackRow
  busy: boolean
  forgeBusy: boolean
  /** True when Restack will also force-push the layers it moves. */
  willPush: boolean
  pullRequests: Record<string, StackPullRequest>
  actions: StackCardActions
}) {
  const t = useTranslations("sourceControl.stacks")
  const fixable = canRestack(row.verdict)
  const stateOf = (branch: string) => row.states.find((state) => state.branch === branch)
  const anyBusy = busy || forgeBusy

  return (
    <div
      className="space-y-2 rounded-md border bg-background/40 p-3"
      data-testid={`stack-${row.stack.id}`}
      data-ok={row.verdict.ok ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {row.stack.layers[row.stack.layers.length - 1]?.branch}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {t("trunk", { branch: row.stack.trunk })} ·{" "}
            {t("layerCount", { count: row.stack.layers.length })}
          </p>
        </div>
        {fixable ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={anyBusy}
            onClick={actions.onRestack}
            data-testid={`stack-restack-${row.stack.id}`}
          >
            {busy ? <Spinner className="size-3" /> : null}
            {busy ? t("restacking") : willPush ? t("restackAndPush") : t("restack")}
          </Button>
        ) : null}
      </div>

      <ol className="space-y-1">
        {[...row.stack.layers]
          .sort((left, right) => left.order - right.order)
          .map((layer) => {
            const state = stateOf(layer.branch)
            const pullRequest = pullRequests[layer.branch]
            const pinned = row.history[layer.branch]?.[0]
            return (
              <li
                key={layer.branch}
                className="flex items-center justify-between gap-2 rounded bg-background/70 px-2 py-1"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-[11px]">{layer.branch}</span>
                  {pullRequest ? (
                    <a
                      href={pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                      data-testid={`stack-pr-${layer.branch}`}
                    >
                      <GitPullRequestIcon className="size-3" />
                      {t("pullRequest", { number: pullRequest.number })}
                      <ExternalLinkIcon className="size-2.5" />
                    </a>
                  ) : null}
                  {state?.checkedOutIn ? (
                    <Badge variant="secondary" className="shrink-0 text-[9px] font-normal">
                      {t("checkedOutAt", { path: state.checkedOutIn })}
                    </Badge>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {pinned ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 shrink-0 gap-1 px-1.5 text-[10px]"
                      disabled={anyBusy}
                      title={t("undoTitle", { ref: pinned.ref })}
                      onClick={() => actions.onUndo(layer.branch, pinned.ref)}
                      data-testid={`stack-undo-${layer.branch}`}
                    >
                      <Undo2Icon className="size-3" />
                      {t("undo")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 shrink-0 px-1.5 text-[10px]"
                    disabled={anyBusy}
                    onClick={() => actions.onUnstack(layer.branch)}
                  >
                    {t("unstack")}
                  </Button>
                </span>
              </li>
            )
          })}
      </ol>

      {row.verdict.ok ? (
        <p className="text-[10px] text-muted-foreground">{t("healthy")}</p>
      ) : (
        <div className="space-y-1" data-testid={`stack-problems-${row.stack.id}`}>
          {row.verdict.problems.map((problem, index) => (
            <p
              key={`${problem.kind}-${index}`}
              className="text-[10px] text-amber-600 dark:text-amber-500"
            >
              {t(`problem.${problem.kind}`, problemValues(problem))}
            </p>
          ))}
          <p className="text-[10px] font-medium">{t(`remedy.${row.verdict.remedy}`)}</p>
        </div>
      )}

      {/* Publishing a stack that does not validate opens pull requests that
          contain each other's diffs — the one outcome this panel exists to
          prevent — so both forge actions wait for a clean verdict. */}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 px-2 text-[11px]"
          disabled={anyBusy || !row.verdict.ok}
          onClick={actions.onPublish}
          data-testid={`stack-publish-${row.stack.id}`}
        >
          {forgeBusy ? <Spinner className="size-3" /> : null}
          {forgeBusy ? t("publishing") : t("publish")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 flex-1 px-2 text-[11px]"
          disabled={anyBusy || !row.verdict.ok}
          onClick={actions.onLand}
          data-testid={`stack-land-${row.stack.id}`}
        >
          {t("land")}
        </Button>
      </div>
    </div>
  )
}

export function StackPanel({
  open,
  onOpenChange,
  rootDir,
  branches,
  deps,
  forgeDeps,
  identity = gitIdentity,
  createBranch = gitCreateBranch,
}: StackPanelProps) {
  const t = useTranslations("sourceControl.stacks")
  const { rows, loading, busy, restack, setParent, undo } = useStacks(open ? rootDir : null, deps)
  const forge = useStackForge(open ? rootDir : null, forgeDeps)
  const [child, setChild] = useState("")
  const [parent, setParent_] = useState("")
  const [newBase, setNewBase] = useState("")
  const [newTitle, setNewTitle] = useState("")
  const [newBranch, setNewBranch] = useState("")
  const [branchEdited, setBranchEdited] = useState(false)
  const [user, setUser] = useState("")

  const local = branches.filter((branch) => !branch.isRemote)

  // The `{user}` half of the default branch name is the commit identity — the
  // same name their commits already carry, not an account from somewhere else.
  useEffect(() => {
    if (!open || !rootDir) return
    let cancelled = false
    void identity(rootDir)
      .then((found) => {
        if (!cancelled) setUser(found.name ?? "")
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, rootDir, identity])

  // Derived until the name is touched, then left alone: a field that keeps
  // overwriting what someone typed is worse than one that never filled in.
  const derivedBranch = renderBranchName(DEFAULT_BRANCH_TEMPLATE, { user, slug: newTitle })
  const branchName = branchEdited ? newBranch : derivedBranch

  const report = (outcome: StackForgeOutcome) => {
    if (outcome.kind === "unavailable") {
      const unavailable = outcome.forge
      toast.warning(
        t(`forge.${unavailable.status}`, {
          host: unavailable.status === "unsupportedHost" ? unavailable.host : "",
          repository: unavailable.status === "noCredential" ? unavailable.repository : "",
        })
      )
      return
    }
    if (outcome.kind === "published") {
      const result = outcome.result
      if (result.status === "forkOnly") {
        toast.warning(t("result.forkOnly", { repository: result.repository }))
        return
      }
      const created = result.layers.filter((entry) => entry.action === "created").length
      const retargeted = result.layers.filter((entry) => entry.action === "retargeted").length
      toast.success(t("result.published", { created, retargeted }))
      // Said out loud rather than implied: this git could only offer the lease
      // a background fetch can satisfy, which is not the guarantee people
      // believe `--force-with-lease` gives them.
      if (!outcome.pushed.forceIfIncludes) toast.warning(t("result.weakLease"))
      return
    }
    const result = outcome.result
    switch (result.status) {
      case "merged":
        toast.success(t("result.merged", { count: result.merged.length }))
        break
      case "blocked":
        toast.warning(
          t("result.blocked", {
            branch: result.branch,
            reason: t(`mergeBlocked.${result.reason}`),
          })
        )
        break
      case "conflict":
        toast.warning(
          t("result.mergeConflict", { branch: result.branch, worktree: result.worktree })
        )
        break
      case "restackRefused":
        toast.warning(t("result.restackRefused"))
        break
      case "unsupportedMethod":
        toast.warning(t("result.unsupportedMethod", { allowed: result.allowed.join(", ") }))
        break
    }
  }

  const guard = async (run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      toast.error(t("error", { message: errorDetail(err) }))
    }
  }

  const record = () =>
    guard(async () => {
      if (!child || !parent || child === parent) return
      await setParent(child, parent)
      setChild("")
      setParent_("")
    })

  const addLayer = () =>
    guard(async () => {
      if (!newBase || !branchName) return
      // Branch first, pointer second. A pointer to a branch that does not
      // exist is exactly the `missingBranch` problem the validator reports,
      // and creating it in that order means a failure here leaves nothing
      // behind rather than a half-recorded layer.
      await createBranch(rootDir, branchName, true, newBase)
      await setParent(branchName, newBase)
      setNewTitle("")
      setNewBranch("")
      setBranchEdited(false)
    })

  const runRestack = (row: StackRow) =>
    guard(async () => {
      // Push only when this stack already has pull requests: they would
      // otherwise show commits that no longer exist. Without them a restack is
      // a local operation and stays one.
      const published = row.stack.layers.some((layer) => forge.pullRequests[layer.branch])
      const remote = forge.forge?.status === "ready" ? forge.forge.remote : undefined
      const result = await restack(
        row.stack,
        published && remote ? { remote, announce: forge.announce } : {}
      )
      if (!result) return
      if (result.status === "upToDate") toast.success(t("result.upToDate"))
      else if (result.status === "restacked")
        toast.success(t("result.restacked", { count: result.updates.length }))
      else if (result.status === "conflict")
        toast.warning(t("result.conflict", { branch: result.branch, worktree: result.worktree }))
      else toast.warning(t("result.refused"))
    })

  const runPublish = (stack: Stack) => guard(async () => report(await forge.publish(stack)))
  const runLand = (stack: Stack) => guard(async () => report(await forge.merge(stack)))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-9rem)] px-4 pb-4">
          <div className="space-y-3" data-testid="stack-panel-body">
            {loading ? (
              <div className="flex justify-center py-6">
                <Spinner className="size-4" />
              </div>
            ) : rows.length === 0 ? (
              <div className="space-y-1" data-testid="stack-panel-empty">
                <p className="text-xs text-muted-foreground">{t("empty")}</p>
                <p className="text-[10px] text-muted-foreground">{t("emptyHint")}</p>
              </div>
            ) : (
              rows.map((row) => (
                <StackCard
                  key={row.stack.id}
                  row={row}
                  busy={busy === row.stack.id}
                  forgeBusy={forge.busy === row.stack.id}
                  willPush={
                    forge.forge?.status === "ready" &&
                    row.stack.layers.some((layer) => forge.pullRequests[layer.branch])
                  }
                  pullRequests={forge.pullRequests}
                  actions={{
                    onRestack: () => void runRestack(row),
                    onUnstack: (branch) => void setParent(branch, null),
                    onPublish: () => void runPublish(row.stack),
                    onLand: () => void runLand(row.stack),
                    onUndo: (branch, ref) => void undo(branch, ref),
                  }}
                />
              ))
            )}

            <div className={cn("space-y-2 rounded-md border border-dashed p-3")}>
              <p className="text-[11px] font-medium">{t("stackOn")}</p>
              <div className="grid gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("branch")}</Label>
                  <Select value={child} onValueChange={setChild}>
                    <SelectTrigger className="h-8 text-xs" aria-label={t("branch")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {local.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("parent")}</Label>
                  <Select value={parent} onValueChange={setParent_}>
                    <SelectTrigger className="h-8 text-xs" aria-label={t("parent")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {local
                        .filter((branch) => branch.name !== child)
                        .map((branch) => (
                          <SelectItem key={branch.name} value={branch.name}>
                            {branch.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={!child || !parent || child === parent || busy !== null}
                  onClick={() => void record()}
                  data-testid="stack-record-parent"
                >
                  {t("record")}
                </Button>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-[11px] font-medium">{t("newLayer")}</p>
              <div className="grid gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("newLayerBase")}</Label>
                  <Select value={newBase} onValueChange={setNewBase}>
                    <SelectTrigger className="h-8 text-xs" aria-label={t("newLayerBase")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {local.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("newLayerTitle")}</Label>
                  <Input
                    className="h-8 text-xs"
                    value={newTitle}
                    aria-label={t("newLayerTitle")}
                    placeholder={t("newLayerTitlePlaceholder")}
                    onChange={(event) => setNewTitle(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">{t("newLayerBranch")}</Label>
                  <Input
                    className="h-8 font-mono text-xs"
                    value={branchName}
                    aria-label={t("newLayerBranch")}
                    onChange={(event) => {
                      setBranchEdited(true)
                      setNewBranch(event.target.value)
                    }}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={!newBase || !branchName || busy !== null}
                  onClick={() => void addLayer()}
                  data-testid="stack-add-layer"
                >
                  {t("create")}
                </Button>
                {/* Both authoring models are in the type; only this one can be
                    produced. Saying so here is the difference between a missing
                    feature and one somebody assumes is switched on. */}
                <p className="text-[10px] text-muted-foreground">{t("model.branchPerLayer")}</p>
              </div>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
