"use client"

/**
 * Commit detail: metadata header + the commit's changed-file list; selecting a
 * file shows its diff (vs first parent) in the Monaco DiffViewer.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranchPlusIcon, HistoryIcon, ScanLineIcon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Commit,
  CommitHash,
  CommitMessage,
  CommitMetadata,
  CommitSeparator,
} from "@/components/ai-elements/commit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { gitCommitFiles, gitDiffCommit } from "@/lib/git/commands"
import {
  commitDiffKey,
  type GitCommit,
  type GitDiff,
  type GitFileChange,
  type GitResetMode,
} from "@/types/git"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useGitRead } from "@/hooks/git/use-git-read"
import { DiffLoading, DiffViewer } from "./diff-viewer"
import { ReadError } from "./read-error"
import { AiExplainPopover } from "./ai-explain-popover"
import { splitPath, statusDecoration } from "./status-decoration"

interface CommitDetailProps {
  rootDir: string
  commit: GitCommit
  actions?: Pick<UseGitActionsResult, "reset"> &
    Partial<
      Pick<UseGitActionsResult, "cherryPick" | "revert" | "createBranch" | "checkout" | "can">
    >
  /** Open blame for a file pinned to this commit. */
  onViewBlame?: (path: string, rev: string) => void
  /** Start an interactive rebase from this commit (base = this commit). */
  onInteractiveRebase?: (base: string) => void
}

export function CommitDetail({
  rootDir,
  commit,
  actions,
  onViewBlame,
  onInteractiveRebase,
}: CommitDetailProps) {
  const t = useTranslations("sourceControl")
  const [confirmHardReset, setConfirmHardReset] = useState(false)
  const [branchDialogOpen, setBranchDialogOpen] = useState(false)
  const [branchName, setBranchName] = useState("")
  const [confirmCheckout, setConfirmCheckout] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const cacheDiff = useGitStore((s) => s.cacheDiff)
  const explainEnabled = useSettingsStore(
    (s) => s.settings?.gitSettings?.explainAI?.enabled ?? false
  )
  const can = actions?.can ?? (() => true)

  // Reset the selection when the displayed commit changes — done in render via
  // a previous-value guard rather than an effect (react-hooks/set-state-in-effect).
  const commitKey = `${rootDir}\n${commit.hash}`
  const [prevCommitKey, setPrevCommitKey] = useState(commitKey)
  if (prevCommitKey !== commitKey) {
    setPrevCommitKey(commitKey)
    setSelected(null)
  }

  // The commit's files, keyed by repository + sha, so a newly picked commit
  // reads as loading rather than showing the previous commit's list.
  const filesRead = useGitRead(commitKey, () => gitCommitFiles(rootDir, commit.hash))
  const files: GitFileChange[] = filesRead.data ?? []

  // The selected file's diff: served from the cache (commit diffs never go
  // stale), else read, keyed so a new selection never shows the old diff.
  const selectedKey = selected ? commitDiffKey(commit.hash, selected) : null
  const cachedDiff = useGitStore((s) => (selectedKey ? s.diffCache[selectedKey] : undefined))
  const diffRead = useGitRead(
    selectedKey ? `${rootDir}\u0000${selectedKey}` : null,
    () => gitDiffCommit(rootDir, commit.hash, selected ?? ""),
    {
      enabled: !cachedDiff,
      onData: (fresh) => {
        // Only into the cache of the repository it was read from.
        if (selectedKey && useGitStore.getState().rootDir === rootDir) {
          cacheDiff(selectedKey, fresh)
        }
      },
    }
  )
  const diff: GitDiff | null = cachedDiff ?? diffRead.data ?? null

  const createBranchFromCommit = async () => {
    const name = branchName.trim()
    if (!name || !actions?.createBranch) return
    const failure = await actions.createBranch(name, true, commit.hash)
    if (failure) return
    setBranchDialogOpen(false)
    setBranchName("")
  }

  return (
    <Commit
      className="flex h-full min-h-0 flex-col rounded-none border-0"
      data-testid="commit-detail"
      defaultOpen
    >
      <header className="shrink-0 border-b p-3">
        <div className="flex items-start justify-between gap-2">
          <CommitMessage className="min-w-0 flex-1">{commit.summary}</CommitMessage>
          {actions && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 gap-1 px-1.5 text-xs"
                  data-testid="commit-reset"
                >
                  <HistoryIcon className="size-3.5" />
                  {t("reset.label")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {actions.cherryPick && (
                  <DropdownMenuItem
                    onSelect={() => void actions.cherryPick?.(commit.hash)}
                    disabled={!can("git_cherry_pick")}
                    data-testid="commit-cherry-pick"
                  >
                    {t("sequencer.cherryPick")}
                  </DropdownMenuItem>
                )}
                {actions.revert && (
                  <DropdownMenuItem
                    onSelect={() => void actions.revert?.(commit.hash)}
                    disabled={!can("git_revert")}
                    data-testid="commit-revert"
                  >
                    {t("sequencer.revert")}
                  </DropdownMenuItem>
                )}
                {onInteractiveRebase && (
                  <DropdownMenuItem
                    // preventDefault: opening an overlay from a closing menu races
                    // Radix focus restore (sticky body[pointer-events:none]).
                    onSelect={(e) => {
                      e.preventDefault()
                      onInteractiveRebase(commit.hash)
                    }}
                    disabled={!can("git_interactive_rebase")}
                    data-testid="commit-interactive-rebase"
                  >
                    {t("irebase.fromHere")}
                  </DropdownMenuItem>
                )}
                {actions.createBranch && (
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault()
                      setBranchDialogOpen(true)
                    }}
                    disabled={!can("git_create_branch")}
                    data-testid="commit-create-branch"
                  >
                    {t("commitDetail.createBranchHere")}
                  </DropdownMenuItem>
                )}
                {actions.checkout && (
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault()
                      setConfirmCheckout(true)
                    }}
                    disabled={!can("git_checkout_branch")}
                    data-testid="commit-checkout"
                  >
                    {t("commitDetail.checkoutCommit")}
                  </DropdownMenuItem>
                )}
                {(actions.cherryPick ||
                  actions.revert ||
                  actions.createBranch ||
                  actions.checkout ||
                  onInteractiveRebase) && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={() => void actions.reset("soft", commit.hash)}
                  disabled={!can("git_reset")}
                  data-testid="reset-soft"
                >
                  {t("reset.soft")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void actions.reset("mixed", commit.hash)}
                  disabled={!can("git_reset")}
                  data-testid="reset-mixed"
                >
                  {t("reset.mixed")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={(e) => {
                    e.preventDefault()
                    setConfirmHardReset(true)
                  }}
                  disabled={!can("git_reset")}
                  data-testid="reset-hard"
                >
                  {t("reset.hard")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {commit.body && (
          <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {commit.body}
          </pre>
        )}
        <CommitMetadata className="mt-1.5 text-[11px]">
          <CommitHash>{commit.shortHash}</CommitHash>
          <CommitSeparator />
          <span>{commit.authorName}</span>
        </CommitMetadata>
      </header>

      <Dialog
        open={branchDialogOpen}
        onOpenChange={(open) => {
          setBranchDialogOpen(open)
          if (!open) setBranchName("")
        }}
      >
        <DialogContent className="sm:max-w-sm" data-testid="create-branch-dialog">
          <DialogHeader>
            <DialogTitle>{t("commitDetail.createBranchTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && branchName.trim()) {
                e.preventDefault()
                void createBranchFromCommit()
              }
            }}
            placeholder={t("commitDetail.branchNamePlaceholder")}
            data-testid="create-branch-name"
          />
          <DialogFooter>
            <Button
              disabled={!branchName.trim() || !can("git_create_branch")}
              onClick={() => void createBranchFromCommit()}
              data-testid="create-branch-confirm"
            >
              <GitBranchPlusIcon className="size-3.5" />
              {t("commitDetail.createBranchAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmCheckout} onOpenChange={setConfirmCheckout}>
        <AlertDialogContent data-testid="checkout-commit-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("commitDetail.checkoutCommitTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("commitDetail.checkoutCommitDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                const checkout = actions?.checkout
                if (!checkout) return
                void checkout(commit.hash).then((failure) => {
                  if (!failure) setConfirmCheckout(false)
                })
              }}
              disabled={!can("git_checkout_branch")}
              data-testid="checkout-commit-confirm-action"
            >
              {t("commitDetail.checkoutAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmHardReset} onOpenChange={setConfirmHardReset}>
        <AlertDialogContent data-testid="reset-hard-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reset.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reset.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                if (!actions) return
                void actions.reset("hard" as GitResetMode, commit.hash).then((failure) => {
                  if (!failure) setConfirmHardReset(false)
                })
              }}
              disabled={!can("git_reset")}
              data-testid="reset-hard-confirm-action"
            >
              {t("reset.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Measured on this pane, not the window: in the desktop's stacked
          layout or the phone's drawer the pane is a few hundred pixels wide,
          and a 224px file column beside the diff left the diff a sliver. */}
      <div className="@container/commit-files flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col @lg/commit-files:flex-row">
          <ScrollArea className="max-h-40 shrink-0 border-b @lg/commit-files:max-h-none @lg/commit-files:w-56 @lg/commit-files:border-r @lg/commit-files:border-b-0">
            <ul className="flex flex-col p-1">
              {files.map((f) => {
                const deco = statusDecoration(f.status)
                const { name, dir } = splitPath(f.path)
                return (
                  <li
                    key={f.path}
                    className={cn(
                      "group flex items-center gap-1 rounded pr-1 hover:bg-accent",
                      selected === f.path && "bg-accent"
                    )}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setSelected(f.path)}
                      className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded px-2 py-1 text-left text-xs font-normal"
                      data-testid={`commit-file-${f.path}`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {name}
                        {dir && (
                          <span className="ml-1 text-[10px] text-muted-foreground">{dir}</span>
                        )}
                      </span>
                      <span className={cn("font-mono", deco.colorClass)}>{deco.letter}</span>
                    </Button>
                    {onViewBlame && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => onViewBlame(f.path, commit.hash)}
                        className={cn("shrink-0 text-muted-foreground", HOVER_REVEAL_CONTROL_CLASS)}
                        aria-label={t("actions.viewBlame")}
                        title={t("actions.viewBlame")}
                        data-testid={`commit-blame-${f.path}`}
                      >
                        <ScanLineIcon className="size-3" />
                      </Button>
                    )}
                  </li>
                )
              })}
              {filesRead.error ? (
                <li>
                  <ReadError
                    message={filesRead.error}
                    onRetry={filesRead.retry}
                    testId="commit-files-error"
                  />
                </li>
              ) : filesRead.loading ? (
                <li
                  role="status"
                  className="px-2 py-2 text-xs text-muted-foreground"
                  data-testid="commit-files-loading"
                >
                  {t("read.loading")}
                </li>
              ) : files.length === 0 ? (
                <li className="px-2 py-2 text-xs text-muted-foreground">
                  {t("commitDetail.noFiles")}
                </li>
              ) : null}
            </ul>
          </ScrollArea>
          <div className="flex min-h-0 flex-1 flex-col">
            {explainEnabled && diff && !diff.isBinary && diff.hunks.length > 0 && selected && (
              <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
                <AiExplainPopover
                  subject={`commit ${commit.shortHash} · ${selected}`}
                  diffText={diff.hunks.map((h) => h.patch).join("\n")}
                />
              </div>
            )}
            <div className="min-h-0 flex-1">
              {selected && !diff && diffRead.error ? (
                <ReadError
                  variant="block"
                  message={diffRead.error}
                  onRetry={diffRead.retry}
                  testId="commit-diff-error"
                />
              ) : selected && !diff ? (
                <DiffLoading />
              ) : (
                <DiffViewer diff={diff} staged={false} />
              )}
            </div>
          </div>
        </div>
      </div>
    </Commit>
  )
}
