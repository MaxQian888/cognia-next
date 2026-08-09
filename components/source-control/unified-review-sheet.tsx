"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react"
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
import { createReviewComment } from "@/lib/review/contracts"
import { createGitHubPullRequestProvider } from "@/lib/review/github-runtime"
import {
  collectReviewScope,
  type ReviewScopedFile,
  type ReviewScopedHunk,
} from "@/lib/review/scope"
import { useDiffReviewStore } from "@/stores/git/diff-review-store"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import type {
  PullRequestProvider,
  PullRequestRef,
  ReviewFeedbackBundle,
  ReviewScope,
} from "@/types/review"
import { CommitBox } from "./commit-box"

type CommitActions = Pick<UseGitActionsResult, "commit" | "push" | "sync" | "stage">

function fileKey(file: Pick<ReviewScopedFile, "repositoryRoot" | "path" | "staged">): string {
  return `${file.repositoryRoot}\n${file.path}\n${Boolean(file.staged)}`
}

function hunkKey(file: ReviewScopedFile, hunk: ReviewScopedHunk): string {
  return `${fileKey(file)}\n${hunk.hunkHash}\n${hunk.index}`
}

function isUniqueHunk(file: ReviewScopedFile, hunk: ReviewScopedHunk): boolean {
  return file.hunks.filter((candidate) => candidate.hunkHash === hunk.hunkHash).length === 1
}

export function UnifiedReviewSheet({
  open,
  onOpenChange,
  rootDir,
  repositoryRoots,
  branch,
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
  branch: string | null
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
  const [scope, setScope] = useState<ReviewScope>("uncommitted")
  const [selectedRoots, setSelectedRoots] = useState<Set<string>>(
    () => new Set(repositoryRoots.length > 0 ? repositoryRoots : [rootDir])
  )
  const [commitSha, setCommitSha] = useState("")
  const [baseRef, setBaseRef] = useState("main")
  const [targetRef, setTargetRef] = useState(branch ?? "HEAD")
  const [files, setFiles] = useState<ReviewScopedFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [comments, setComments] = useState<Record<string, string>>({})
  const [staleCommentCount, setStaleCommentCount] = useState(0)
  const [summary, setSummary] = useState("")
  const [prTitle, setPrTitle] = useState("")
  const [prBody, setPrBody] = useState("")
  const [draftPr, setDraftPr] = useState(true)
  const [auth, setAuth] = useState<"authenticated" | "unauthenticated" | "unavailable">(
    "unavailable"
  )
  const [pullRequest, setPullRequest] = useState<PullRequestRef | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const setStoredComment = useDiffReviewStore((state) => state.setComment)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void provider.getAuthenticationState().then((state) => {
      if (!cancelled) setAuth(state)
    })
    return () => {
      cancelled = true
    }
  }, [open, provider])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setSuccess(false)
    try {
      await operation()
      setSuccess(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const loadScope = () =>
    run(async () => {
      const rows = await collectReviewScope({
        scope,
        repositoryRoots: [...selectedRoots],
        lastTurnRunIdByRoot,
        commitSha: commitSha.trim() || undefined,
        baseRef: baseRef.trim() || undefined,
        targetRef: targetRef.trim() || undefined,
      })
      setFiles(rows)
      setSelectedFiles(new Set(rows.map(fileKey)))
      const storedComments: Record<string, string> = {}
      let staleCount = 0
      const reviewStore = useDiffReviewStore.getState()
      for (const file of rows) {
        for (const stored of reviewStore.getFileDecisions(file.repositoryRoot, file.reviewKey)) {
          if (!stored.comment?.trim()) continue
          const matches = file.hunks.filter((hunk) => hunk.hunkHash === stored.hash)
          if (matches.length !== 1) {
            staleCount += 1
            continue
          }
          storedComments[hunkKey(file, matches[0])] = stored.comment
        }
      }
      setComments(storedComments)
      setStaleCommentCount(staleCount)
    })

  const feedbackBundle = async (): Promise<ReviewFeedbackBundle> => {
    const now = Date.now()
    const authored = await Promise.all(
      files.flatMap((file) => {
        if (!selectedFiles.has(fileKey(file))) return []
        return file.hunks.flatMap((hunk) => {
          const body = comments[hunkKey(file, hunk)]?.trim()
          if (!body || !isUniqueHunk(file, hunk)) return []
          return [
            createReviewComment({
              anchor: {
                repositoryRoot: file.repositoryRoot,
                path: file.path,
                hunkHash: hunk.hunkHash,
                side: hunk.side,
                line: hunk.line,
                ...(scope === "commit" && commitSha ? { commitSha } : {}),
              },
              body,
              createdAt: now,
            }),
          ]
        })
      })
    )
    return {
      id: `review-feedback:${crypto.randomUUID()}`,
      sessionId: "source-control",
      scope,
      repositoryRoots: [...selectedRoots],
      comments: authored,
      summary,
      state: "draft",
      createdAt: now,
      updatedAt: now,
    }
  }

  const lookup = () =>
    run(async () => {
      if (!branch) throw new Error("The current branch is unavailable")
      setPullRequest(await provider.findForBranch(rootDir, branch))
    })

  const push = () =>
    run(async () => {
      if (!branch) throw new Error("The current branch is unavailable")
      await provider.push(rootDir, branch)
    })

  const create = () =>
    run(async () => {
      if (!branch) throw new Error("The current branch is unavailable")
      await provider.push(rootDir, branch)
      setPullRequest(
        await provider.create({
          repositoryRoot: rootDir,
          headRef: branch,
          baseRef,
          title: prTitle,
          body: prBody,
          draft: draftPr,
        })
      )
    })

  const publish = () =>
    run(async () => {
      if (!pullRequest) throw new Error("No pull request is selected")
      await provider.publishFeedback(pullRequest, await feedbackBundle())
    })

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
              <Select value={scope} onValueChange={(value) => setScope(value as ReviewScope)}>
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
              <div className="space-y-1.5">
                <Label className="text-xs">{t("roots")}</Label>
                {repositoryRoots.map((repositoryRoot) => (
                  <label key={repositoryRoot} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={selectedRoots.has(repositoryRoot)}
                      onCheckedChange={(checked) =>
                        setSelectedRoots((current) => {
                          const next = new Set(current)
                          if (checked) next.add(repositoryRoot)
                          else next.delete(repositoryRoot)
                          return next
                        })
                      }
                    />
                    <span className="break-all font-mono">{repositoryRoot}</span>
                  </label>
                ))}
              </div>
              {scope === "commit" && (
                <Input
                  aria-label={t("commitSha")}
                  placeholder={t("commitSha")}
                  value={commitSha}
                  onChange={(event) => setCommitSha(event.target.value)}
                />
              )}
              {scope === "branch" && (
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    aria-label={t("baseRef")}
                    placeholder={t("baseRef")}
                    value={baseRef}
                    onChange={(event) => setBaseRef(event.target.value)}
                  />
                  <Input
                    aria-label={t("targetRef")}
                    placeholder={t("targetRef")}
                    value={targetRef}
                    onChange={(event) => setTargetRef(event.target.value)}
                  />
                </div>
              )}
              <Button
                size="sm"
                disabled={busy || selectedRoots.size === 0}
                onClick={() => void loadScope()}
              >
                {busy ? t("loading") : t("load")}
              </Button>
            </section>

            <section className="space-y-2 rounded-md border p-3">
              <Label className="text-xs">{t("files")}</Label>
              <p className="text-[10px] text-muted-foreground">{t("hunkHint")}</p>
              {staleCommentCount > 0 && (
                <p className="text-xs text-amber-600" role="status">
                  {t("staleComments", { count: staleCommentCount })}
                </p>
              )}
              {files.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("empty")}</p>
              ) : (
                files.map((file) => {
                  const key = fileKey(file)
                  return (
                    <div key={key} className="space-y-2 rounded-md border p-2">
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          checked={selectedFiles.has(key)}
                          onCheckedChange={(checked) =>
                            setSelectedFiles((current) => {
                              const next = new Set(current)
                              if (checked) next.add(key)
                              else next.delete(key)
                              return next
                            })
                          }
                        />
                        <span className="break-all font-mono">{file.path}</span>
                      </label>
                      {file.hunks.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("noHunks")}</p>
                      ) : (
                        file.hunks.map((hunk) => {
                          const keyForHunk = hunkKey(file, hunk)
                          const unique = isUniqueHunk(file, hunk)
                          return (
                            <div key={keyForHunk} className="space-y-1 rounded bg-muted/30 p-2">
                              <p className="truncate font-mono text-[11px] text-muted-foreground">
                                {hunk.header || t("hunkLine", { line: hunk.line })}
                              </p>
                              <Textarea
                                aria-label={t("comment", { path: file.path, line: hunk.line })}
                                placeholder={unique ? t("commentPlaceholder") : t("ambiguousHunk")}
                                disabled={!unique || !selectedFiles.has(key)}
                                value={comments[keyForHunk] ?? ""}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setComments((current) => ({ ...current, [keyForHunk]: value }))
                                  setStoredComment(
                                    file.repositoryRoot,
                                    file.reviewKey,
                                    hunk.index,
                                    hunk.hunkHash,
                                    value
                                  )
                                }}
                              />
                            </div>
                          )
                        })
                      )}
                    </div>
                  )
                })
              )}
            </section>

            <section className="space-y-2 rounded-md border p-3">
              <Label className="text-xs">{t("draft")}</Label>
              <Textarea
                aria-label={t("summary")}
                placeholder={t("summary")}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("auth", { state: t(`authStates.${auth}`) })}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || auth !== "authenticated"}
                  onClick={() => void lookup()}
                >
                  {t("lookup")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || auth !== "authenticated"}
                  onClick={() => void push()}
                >
                  {t("push")}
                </Button>
              </div>
              {pullRequest && (
                <a
                  href={pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-primary underline"
                >
                  <ExternalLinkIcon className="size-3" />
                  {t("existing", { number: pullRequest.number, title: pullRequest.title })}
                </a>
              )}
              <Input
                aria-label={t("prTitle")}
                placeholder={t("prTitle")}
                value={prTitle}
                onChange={(event) => setPrTitle(event.target.value)}
              />
              <Textarea
                aria-label={t("prBody")}
                placeholder={t("prBody")}
                value={prBody}
                onChange={(event) => setPrBody(event.target.value)}
              />
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={draftPr}
                  onCheckedChange={(checked) => setDraftPr(Boolean(checked))}
                />
                {t("draftPr")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  disabled={busy || auth !== "authenticated" || !prTitle.trim()}
                  onClick={() => void create()}
                >
                  {t("create")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !pullRequest}
                  onClick={() => void publish()}
                >
                  {t("publish")}
                </Button>
              </div>
            </section>

            {error && (
              <div
                className="flex items-center justify-between gap-2 text-xs text-destructive"
                role="alert"
              >
                <span>{t("error", { message: error })}</span>
                <Button size="sm" variant="ghost" onClick={() => void lookup()}>
                  <RefreshCwIcon className="size-3" />
                  {t("retry")}
                </Button>
              </div>
            )}
            {success && (
              <p className="text-xs text-emerald-600" role="status">
                {t("success")}
              </p>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
