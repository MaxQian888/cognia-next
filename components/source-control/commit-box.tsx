"use client"

/**
 * Commit message box + split commit button. The dropdown offers amend, commit
 * & push, commit & sync, and a sign-off toggle (VSCode parity).
 */

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ChevronDownIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useAiCommitMessage } from "@/hooks/git/use-ai-commit-message"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"
import { GIT_DEFAULTS, useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { PostCommitAction } from "@/lib/git/panel-prefs"
import { GitIdentityDialog } from "./git-identity-dialog"

interface CommitBoxProps {
  rootDir: string
  stagedCount: number
  committing: boolean
  actions: Pick<UseGitActionsResult, "commit" | "push" | "sync" | "stage">
}

export function CommitBox({ rootDir, stagedCount, committing, actions }: CommitBoxProps) {
  const t = useTranslations("sourceControl")
  const draft = useGitStore((s) => s.commitDraft[rootDir] ?? "")
  const setCommitDraft = useGitStore((s) => s.setCommitDraft)
  const amend = useGitStore((s) => s.commitAmend)
  const setAmend = useGitStore((s) => s.setAmend)
  const [signoff, setSignoff] = useState(false)
  const [identityOpen, setIdentityOpen] = useState(false)
  const pendingPostCommit = useRef<PostCommitAction | undefined>(undefined)
  const aiEnabled = useSettingsStore(
    (s) => s.settings?.gitSettings?.commitMessageAI?.enabled ?? false
  )
  const ai = useAiCommitMessage(rootDir)
  const { prefs } = useSourceControlPrefs()
  const unstagedCount = useGitStore((s) => s.status?.changes.length ?? 0)
  // Smart commit (VSCode parity): when nothing is staged but there are
  // working-tree changes, the primary Commit stages them all first.
  const smartWillStage = prefs.smartCommit && stagedCount === 0 && unstagedCount > 0
  // ↑/↓ recall of prior commit messages for THIS repo (multi-line aware: the
  // arrows only step history on the first/last line, leaving normal caret
  // movement inside a multi-line message intact). Persisted per repo root.
  const history = useCommandHistory({ persistKey: `cmdhist:commit:${rootDir}` })

  const canCommit =
    (draft.trim().length > 0 || amend) &&
    (stagedCount > 0 || amend || smartWillStage) &&
    !committing

  const doCommit = useCallback(
    async (afterOverride?: PostCommitAction, retryAfterIdentity = false) => {
      if (!canCommit) return
      if (!retryAfterIdentity) history.record(draft)
      if (smartWillStage && !retryAfterIdentity) {
        // Read the paths fresh so this callback needn't depend on a new array
        // each render.
        const paths = useGitStore.getState().status?.changes.map((c) => c.path) ?? []
        if (paths.length > 0) {
          const stageFailure = await actions.stage(paths)
          if (stageFailure) return
        }
      }
      const failure = await actions.commit(draft, { amend, signoff })
      if (failure?.kind === "identityRequired") {
        pendingPostCommit.current = afterOverride
        setIdentityOpen(true)
        return
      }
      if (failure) return
      setCommitDraft(rootDir, "")
      setAmend(false)
      // The default button chains the configured post-commit action; the split
      // menu items pass an explicit override.
      const after = afterOverride ?? prefs.postCommit
      const hasUpstream = useGitStore.getState().status?.upstream != null
      if (after === "push") {
        // Preserve an existing tracking target (which may not be `origin`).
        // `--set-upstream` is only a publish operation for a new branch.
        if (hasUpstream) await actions.push()
        else await actions.push({ setUpstream: true })
      } else if (after === "sync") {
        // A new branch cannot pull/sync until it has an upstream; publishing it
        // already leaves local and remote synchronized.
        if (hasUpstream) await actions.sync()
        else await actions.push({ setUpstream: true })
      }
    },
    [
      canCommit,
      actions,
      draft,
      amend,
      signoff,
      setCommitDraft,
      rootDir,
      setAmend,
      history,
      smartWillStage,
      prefs.postCommit,
    ]
  )

  return (
    <div className="flex flex-col gap-1.5 p-2" data-testid="commit-box">
      <Textarea
        value={draft}
        onChange={(e) => {
          setCommitDraft(rootDir, e.target.value)
          history.noteEdit()
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            void doCommit()
            return
          }
          handleHistoryArrowKey(e, history, (v) => setCommitDraft(rootDir, v))
        }}
        rows={GIT_DEFAULTS.commitBoxRows}
        placeholder={t("commit.placeholder")}
        aria-label={t("commit.placeholder")}
        className="resize-none text-sm"
        data-testid="commit-message"
      />
      <div className="flex items-stretch gap-px">
        {aiEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="px-2"
                disabled={ai.generating || stagedCount === 0}
                aria-label={t("commit.autoGenerateAI")}
                onClick={() => void ai.generate()}
                data-testid="commit-ai-generate"
              >
                {ai.generating ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("commit.autoGenerateAI")}</TooltipContent>
          </Tooltip>
        )}
        <Button
          className="flex-1 gap-1.5"
          size="sm"
          disabled={!canCommit}
          onClick={() => void doCommit()}
          data-testid="commit-button"
        >
          {committing ? <Spinner className="size-3.5" /> : <CheckIcon className="size-3.5" />}
          {amend ? t("commit.amend") : t("commit.commit")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="px-1.5"
              aria-label={t("commit.more")}
              data-testid="commit-more"
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={!canCommit}
              onSelect={() => void doCommit("push")}
              data-testid="commit-and-push"
            >
              {t("commit.commitAndPush")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canCommit}
              onSelect={() => void doCommit("sync")}
              data-testid="commit-and-sync"
            >
              {t("commit.commitAndSync")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={amend}
              onCheckedChange={setAmend}
              data-testid="commit-amend-toggle"
            >
              {t("commit.amend")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={signoff}
              onCheckedChange={(v) => setSignoff(Boolean(v))}
              data-testid="commit-signoff-toggle"
            >
              {t("commit.signoff")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <GitIdentityDialog
        open={identityOpen}
        repoPath={rootDir}
        onOpenChange={setIdentityOpen}
        onSaved={() => doCommit(pendingPostCommit.current, true)}
      />
    </div>
  )
}
