"use client"

/**
 * The unified review surface.
 *
 * Layout only — every rule about scope, refs, pull requests and delivery lives
 * in `use-review-workspace.ts`. The two were tangled before, which is how a
 * sheet that collected review across N repositories ended up publishing all of
 * it to whichever one happened to be first.
 *
 * Cross-repository publishing follows ADR-0111 §6: one pull request per
 * repository, grouped into one delivery unit here, with no claim of atomicity
 * across them. Each repository therefore gets its own row — branch, pull
 * request, refs — and the delivery reports each leg separately.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Textarea } from "@/components/ui/textarea"
import { createGitHubPullRequestProvider } from "@/lib/review/github-runtime"
import {
  isUniqueHunk,
  reviewFileKey,
  reviewHunkKey,
  useReviewWorkspace,
  type ReviewWorkspace,
} from "./use-review-workspace"
import type { ReviewScopeFileRef } from "@/lib/review/scope"
import type { PullRequestProvider, ReviewDeliveryLeg, ReviewScope } from "@/types/review"
import { CommitBox } from "./commit-box"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

type CommitActions = Pick<UseGitActionsResult, "commit" | "push" | "sync" | "stage">

export function UnifiedReviewSheet({
  open,
  onOpenChange,
  rootDir,
  repositoryRoots,
  stagedCount,
  committing,
  actions,
  lastTurnRunIdByRoot,
  provider: providerOverride,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  rootDir: string
  repositoryRoots: string[]
  /** @deprecated Each root's branch is resolved per repository now. */
  branch?: string | null
  stagedCount: number
  committing: boolean
  actions: CommitActions
  lastTurnRunIdByRoot?: Record<string, string>
  provider?: PullRequestProvider
}) {
  const t = useTranslations("unifiedReview")
  const provider = useMemo(
    () => providerOverride ?? createGitHubPullRequestProvider(),
    [providerOverride]
  )
  const workspace = useReviewWorkspace({
    rootDir,
    repositoryRoots,
    ...(lastTurnRunIdByRoot ? { lastTurnRunIdByRoot } : {}),
    provider,
    open,
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [prTitle, setPrTitle] = useState("")
  const [prBody, setPrBody] = useState("")
  const [draftPr, setDraftPr] = useState(true)

  const allRoots = repositoryRoots.length > 0 ? repositoryRoots : [rootDir]
  const needsRefs = workspace.scope === "commit" || workspace.scope === "branch"

  const toggleExpanded = (ref: ReviewScopeFileRef) => {
    const key = reviewFileKey(ref)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else {
        next.add(key)
        if (!workspace.hunksByFile[key]) void workspace.loadFile(ref)
      }
      return next
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            <section className="space-y-2 rounded-md border p-3">
              <Label className="text-xs">{t("commitSection")}</Label>
              <CommitBox
                rootDir={rootDir}
                stagedCount={stagedCount}
                committing={committing}
                actions={actions}
              />
            </section>

            <section className="space-y-3 rounded-md border p-3">
              <Label className="text-xs">{t("scope")}</Label>
              <Select
                value={workspace.scope}
                onValueChange={(value) => workspace.setScope(value as ReviewScope)}
              >
                <SelectTrigger aria-label={t("scope")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["lastTurn", "uncommitted", "commit", "branch"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`scopes.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="space-y-2">
                <Label className="text-xs">{t("roots")}</Label>
                {needsRefs && (
                  <p className="text-[10px] text-muted-foreground">{t("perRootRefs")}</p>
                )}
                {allRoots.map((repositoryRoot) => {
                  const state = workspace.rootState(repositoryRoot)
                  const selected = workspace.selectedRoots.has(repositoryRoot)
                  return (
                    <div key={repositoryRoot} className="space-y-1.5 rounded border p-2">
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) =>
                            workspace.toggleRoot(repositoryRoot, Boolean(checked))
                          }
                        />
                        <span className="break-all font-mono">{repositoryRoot}</span>
                      </label>
                      {selected && workspace.scope === "commit" && (
                        <Input
                          aria-label={t("commitShaFor", { root: repositoryRoot })}
                          placeholder={t("commitSha")}
                          value={state.refs.commitSha ?? ""}
                          onChange={(event) =>
                            workspace.setRootRefs(repositoryRoot, {
                              commitSha: event.target.value,
                            })
                          }
                        />
                      )}
                      {selected && workspace.scope === "branch" && (
                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            aria-label={t("baseRefFor", { root: repositoryRoot })}
                            placeholder={t("baseRef")}
                            value={state.refs.baseRef ?? ""}
                            onChange={(event) =>
                              workspace.setRootRefs(repositoryRoot, { baseRef: event.target.value })
                            }
                          />
                          <Input
                            aria-label={t("targetRefFor", { root: repositoryRoot })}
                            placeholder={t("targetRef")}
                            value={state.refs.targetRef ?? ""}
                            onChange={(event) =>
                              workspace.setRootRefs(repositoryRoot, {
                                targetRef: event.target.value,
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <Button
                size="sm"
                disabled={workspace.busy || workspace.selectedRoots.size === 0}
                onClick={() => void workspace.loadScope()}
              >
                {workspace.busy ? t("loading") : t("load")}
              </Button>
            </section>

            <section className="space-y-2 rounded-md border p-3">
              <Label className="text-xs">{t("files")}</Label>
              <p className="text-[10px] text-muted-foreground">{t("hunkHint")}</p>
              {workspace.unavailableRoots.map((root) => (
                <p key={root.repositoryRoot} className="text-xs text-amber-600" role="status">
                  {t(`unavailable.${root.reason}`, { root: root.repositoryRoot })}
                </p>
              ))}
              {workspace.staleCommentCount > 0 && (
                <p className="text-xs text-amber-600" role="status">
                  {t("staleComments", { count: workspace.staleCommentCount })}
                </p>
              )}
              {workspace.files.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("empty")}</p>
              ) : (
                workspace.files.map((ref) => (
                  <FileRow
                    key={reviewFileKey(ref)}
                    fileRef={ref}
                    workspace={workspace}
                    expanded={expanded.has(reviewFileKey(ref))}
                    onToggleExpanded={() => toggleExpanded(ref)}
                  />
                ))
              )}
            </section>

            <RepositoriesSection
              workspace={workspace}
              prTitle={prTitle}
              prBody={prBody}
              draftPr={draftPr}
              onPrTitle={setPrTitle}
              onPrBody={setPrBody}
              onDraftPr={setDraftPr}
            />

            <section className="space-y-2 rounded-md border p-3">
              <Label className="text-xs">{t("draft")}</Label>
              <Textarea
                aria-label={t("summary")}
                placeholder={t("summary")}
                value={workspace.summary}
                onChange={(event) => workspace.setSummary(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={workspace.busy}
                onClick={() => void workspace.publish()}
              >
                {t("publish")}
              </Button>
              {workspace.delivery && <DeliveryReport workspace={workspace} />}
            </section>

            {workspace.error && (
              <div
                className="flex items-center justify-between gap-2 text-xs text-destructive"
                role="alert"
              >
                <span>{t("error", { message: workspace.error })}</span>
                <Button size="sm" variant="ghost" onClick={() => void workspace.lookupAll()}>
                  <RefreshCwIcon className="size-3" />
                  {t("retry")}
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function FileRow({
  fileRef,
  workspace,
  expanded,
  onToggleExpanded,
}: {
  fileRef: ReviewScopeFileRef
  workspace: ReviewWorkspace
  expanded: boolean
  onToggleExpanded(): void
}) {
  const t = useTranslations("unifiedReview")
  const key = reviewFileKey(fileRef)
  const hunks = workspace.hunksByFile[key]
  const selected = workspace.selectedFiles.has(key)

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={selected}
          aria-label={fileRef.path}
          onCheckedChange={(checked) => workspace.toggleFile(key, Boolean(checked))}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0" />
          )}
          <span className="truncate font-mono">{fileRef.path}</span>
        </button>
      </div>
      {expanded &&
        (hunks === undefined ? (
          <p className="text-xs text-muted-foreground">{t("loading")}</p>
        ) : hunks.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noHunks")}</p>
        ) : (
          hunks.map((hunk) => {
            const unique = isUniqueHunk(hunks, hunk)
            return (
              <div key={reviewHunkKey(fileRef, hunk)} className="space-y-1 rounded bg-muted/30 p-2">
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {hunk.header || t("hunkLine", { line: hunk.line })}
                </p>
                <Textarea
                  aria-label={t("comment", { path: fileRef.path, line: hunk.line })}
                  placeholder={unique ? t("commentPlaceholder") : t("ambiguousHunk")}
                  disabled={!unique || !selected}
                  value={workspace.comments[reviewHunkKey(fileRef, hunk)] ?? ""}
                  onChange={(event) => workspace.setComment(fileRef, hunk, event.target.value)}
                />
              </div>
            )
          })
        ))}
    </div>
  )
}

function RepositoriesSection({
  workspace,
  prTitle,
  prBody,
  draftPr,
  onPrTitle,
  onPrBody,
  onDraftPr,
}: {
  workspace: ReviewWorkspace
  prTitle: string
  prBody: string
  draftPr: boolean
  onPrTitle(value: string): void
  onPrBody(value: string): void
  onDraftPr(value: boolean): void
}) {
  const t = useTranslations("unifiedReview")
  const roots = [...workspace.selectedRoots]

  return (
    <section className="space-y-2 rounded-md border p-3">
      <Label className="text-xs">{t("repositories")}</Label>
      <p className="text-xs text-muted-foreground">
        {t("auth", { state: t(`authStates.${workspace.auth}`) })}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={workspace.busy || workspace.auth !== "authenticated" || roots.length === 0}
        onClick={() => void workspace.lookupAll()}
      >
        {t("lookupAll")}
      </Button>

      <Input
        aria-label={t("prTitle")}
        placeholder={t("prTitle")}
        value={prTitle}
        onChange={(event) => onPrTitle(event.target.value)}
      />
      <Textarea
        aria-label={t("prBody")}
        placeholder={t("prBody")}
        value={prBody}
        onChange={(event) => onPrBody(event.target.value)}
      />
      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={draftPr} onCheckedChange={(checked) => onDraftPr(Boolean(checked))} />
        {t("draftPr")}
      </label>

      {roots.map((repositoryRoot) => {
        const state = workspace.rootState(repositoryRoot)
        return (
          <div key={repositoryRoot} className="space-y-1 rounded border p-2 text-xs">
            <p className="break-all font-mono">{repositoryRoot}</p>
            {state.pullRequest ? (
              <a
                href={state.pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary underline"
              >
                <ExternalLinkIcon className="size-3" />
                {t("existing", {
                  number: state.pullRequest.number,
                  title: state.pullRequest.title,
                })}
              </a>
            ) : (
              <p className="text-muted-foreground">{t("noPullRequest")}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={workspace.busy || workspace.auth !== "authenticated"}
                onClick={() => void workspace.pushRoot(repositoryRoot)}
              >
                {t("push")}
              </Button>
              <Button
                size="sm"
                disabled={workspace.busy || workspace.auth !== "authenticated" || !prTitle.trim()}
                onClick={() =>
                  void workspace.createFor(repositoryRoot, {
                    title: prTitle,
                    body: prBody,
                    draft: draftPr,
                  })
                }
              >
                {t("create")}
              </Button>
            </div>
          </div>
        )
      })}
    </section>
  )
}

/**
 * The delivery unit ADR-0111 §6 describes.
 *
 * Every leg is shown with its own outcome — a success in one repository is not
 * hidden by a failure in another — and retry is offered for the failed legs
 * only. A leg whose request never got an answer is called out separately,
 * because replaying that one may post the same review twice.
 */
function DeliveryReport({ workspace }: { workspace: ReviewWorkspace }) {
  const t = useTranslations("unifiedReview")
  const delivery = workspace.delivery
  if (!delivery) return null

  return (
    <div className="space-y-1.5 rounded border p-2" role="status">
      <p className="text-xs font-medium">{t("delivery.title")}</p>
      {delivery.legs.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("delivery.nothingToSend")}</p>
      )}
      {delivery.legs.map((leg) => (
        <LegRow key={leg.repositoryRoot} leg={leg} />
      ))}
      {workspace.uncertain.length > 0 && (
        <p className="text-xs text-amber-600">
          {t("delivery.uncertain", { count: workspace.uncertain.length })}
        </p>
      )}
      {workspace.failedLegs.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={workspace.busy}
          onClick={() => void workspace.publish({ retry: true })}
        >
          {t("delivery.retryFailed", { count: workspace.failedLegs.length })}
        </Button>
      )}
    </div>
  )
}

const LEG_CLASS: Record<ReviewDeliveryLeg["status"], string> = {
  succeeded: "text-emerald-600",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  pending: "text-muted-foreground",
}

function LegRow({ leg }: { leg: ReviewDeliveryLeg }) {
  const t = useTranslations("unifiedReview")
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="min-w-0 flex-1 break-all font-mono">{leg.repositoryRoot}</span>
      <span className="shrink-0 text-muted-foreground">
        {t("delivery.comments", { count: leg.commentCount })}
      </span>
      <span className={`shrink-0 font-medium ${LEG_CLASS[leg.status]}`}>
        {t(`delivery.${leg.status}`)}
      </span>
    </div>
  )
}
