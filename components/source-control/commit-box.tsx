"use client"

/**
 * Commit message box + split commit button. The dropdown offers amend, commit
 * & push, commit & sync, and a sign-off toggle (VSCode parity).
 *
 * The message box carries its own footer: the AI "Generate" action, which runs
 * the agent the composer has selected (`useAiCommitMessage`) and names it, and
 * the platform's commit chord. While a message streams in it is shown in the
 * box, read-only, with a Stop control in place of Generate.
 *
 * `compact` is the dock review's footer: the message box is one line until
 * it is focused or holds a message, so the list above keeps its height, and
 * `density="touch"` sizes every control for a finger (and the text at 16px,
 * which keeps iOS from zooming into the field).
 */

import { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronDownIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
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
import { formatKeybinding, toAriaKeyShortcuts } from "@/lib/shortcuts/utils"
import { cn } from "@/lib/utils"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"
import { GitIdentityDialog } from "./git-identity-dialog"

/** The chord that commits from the message box, in the stored-chord form. */
const COMMIT_SHORTCUT = "Ctrl+Enter"

interface CommitBoxProps {
  rootDir: string
  stagedCount: number
  committing: boolean
  /** One line until focused or filled (the dock review's footer). */
  compact?: boolean
  density?: "compact" | "touch"
  actions: Pick<UseGitActionsResult, "commit" | "push" | "sync" | "stage"> &
    Partial<Pick<UseGitActionsResult, "can">>
}

export function CommitBox({
  rootDir,
  stagedCount,
  committing,
  actions,
  compact = false,
  density = "compact",
}: CommitBoxProps) {
  const t = useTranslations("sourceControl")
  const [focused, setFocused] = useState(false)
  const touch = density === "touch"
  const draft = useGitStore((s) => s.commitDraft[rootDir] ?? "")
  const collapsed = compact && !focused && draft === ""
  const setCommitDraft = useGitStore((s) => s.setCommitDraft)
  const amend = useGitStore((s) => s.commitAmend)
  const setAmend = useGitStore((s) => s.setAmend)
  const [signoff, setSignoff] = useState(false)
  const [identityOpen, setIdentityOpen] = useState(false)
  const pendingPostCommit = useRef<PostCommitAction | undefined>(undefined)
  const aiEnabled = useSettingsStore(
    (s) =>
      s.settings?.gitSettings?.commitMessageAI?.enabled ??
      DEFAULT_GIT_SETTINGS.commitMessageAI.enabled
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
  const can = actions.can ?? (() => true)

  const canCommit =
    (draft.trim().length > 0 || amend) &&
    (stagedCount > 0 || amend || smartWillStage) &&
    !committing &&
    can("git_commit") &&
    (!smartWillStage || can("git_stage"))

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

  // The label says what a click will commit: a count, "all" when smart commit
  // is about to stage the working tree, or an amend.
  const commitLabel = amend
    ? t("commit.amend")
    : smartWillStage
      ? t("commit.commitAll", { count: unstagedCount })
      : stagedCount > 0
        ? t("commit.commitCount", { count: stagedCount })
        : t("commit.commit")
  const aiLabel = ai.agentName
    ? t("commit.ai.generateWith", { agent: ai.agentName })
    : t("commit.autoGenerateAI")
  const aiBlocked = stagedCount === 0
  // While a message streams in, the box shows it and cannot be edited: two
  // writers into one draft is how a half-typed sentence gets overwritten.
  const shownMessage = ai.generating ? ai.preview : draft

  const aiControl = aiEnabled ? (
    ai.generating ? (
      <InputGroupButton
        size={collapsed ? "icon-xs" : "xs"}
        className={cn("text-muted-foreground", touch && !collapsed && "h-9 px-3")}
        aria-label={t("commit.ai.stop")}
        onClick={ai.cancel}
        data-testid="commit-ai-stop"
      >
        <Spinner className="size-3.5" />
        {!collapsed && (
          <span className="truncate">
            {ai.agentName
              ? t("commit.ai.writingWith", { agent: ai.agentName })
              : t("commit.ai.generating")}
          </span>
        )}
        {!collapsed && <SquareIcon aria-hidden className="size-3 fill-current" />}
      </InputGroupButton>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button fires no pointer events, so the tooltip that
              says WHY it is disabled hangs off this wrapper instead. */}
          <span className="inline-flex" tabIndex={aiBlocked ? 0 : undefined}>
            <InputGroupButton
              size={collapsed ? "icon-xs" : "xs"}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                touch && !collapsed && "h-9 px-3"
              )}
              disabled={aiBlocked}
              aria-label={aiLabel}
              onClick={() => void ai.generate()}
              data-testid="commit-ai-generate"
            >
              <SparklesIcon className="size-3.5" />
              {!collapsed && <span>{t("commit.ai.generate")}</span>}
              {!collapsed && ai.agentName && (
                <span
                  className="max-w-28 truncate text-muted-foreground/80"
                  data-testid="commit-ai-agent"
                >
                  · {ai.agentName}
                </span>
              )}
            </InputGroupButton>
          </span>
        </TooltipTrigger>
        <TooltipContent>{aiBlocked ? t("commit.ai.noStaged") : aiLabel}</TooltipContent>
      </Tooltip>
    )
  ) : null

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="commit-box">
      <InputGroup
        className={cn(
          "bg-background",
          ai.generating && "border-primary/40 ring-[3px] ring-primary/10"
        )}
        data-generating={ai.generating ? "true" : undefined}
      >
        <InputGroupTextarea
          value={shownMessage}
          readOnly={ai.generating}
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={collapsed ? 1 : GIT_DEFAULTS.commitBoxRows}
          placeholder={t("commit.placeholder")}
          aria-label={t("commit.messageLabel")}
          aria-keyshortcuts={toAriaKeyShortcuts(COMMIT_SHORTCUT)}
          aria-busy={ai.generating || undefined}
          className={cn(
            "max-h-60 px-3 py-2.5",
            touch ? "text-base" : "text-sm",
            // One fixed line while collapsed; the base field grows with content.
            collapsed && "[field-sizing:fixed] min-h-0 py-1.5",
            collapsed && (touch ? "h-11" : "h-8")
          )}
          data-testid="commit-message"
          data-expanded={collapsed ? "false" : "true"}
        />
        {collapsed ? (
          aiControl && (
            <InputGroupAddon align="inline-end" className="self-start py-1">
              {aiControl}
            </InputGroupAddon>
          )
        ) : (
          <InputGroupAddon
            align="block-end"
            className="cursor-default justify-between gap-2 px-1.5 pt-0 pb-1.5"
          >
            <div className="flex min-w-0 items-center">{aiControl}</div>
            {!touch && (
              <span
                className="flex shrink-0 items-center gap-1 pr-1 text-[11px] font-normal text-muted-foreground/80"
                data-testid="commit-shortcut-hint"
              >
                <Kbd className="h-4 px-1 text-[10px]">{formatKeybinding(COMMIT_SHORTCUT)}</Kbd>
                {t("commit.shortcutHint")}
              </span>
            )}
          </InputGroupAddon>
        )}
      </InputGroup>
      {/* One control in two halves. Both share the primary look, and the
          chevron only dims (it stays usable: amend and sign-off live there)
          when the commit half is disabled, so the pair never reads as two
          unrelated buttons. */}
      <ButtonGroup className="w-full">
        <Button
          className={cn("min-w-0 flex-1 gap-1.5", touch && "h-11")}
          size="sm"
          disabled={!canCommit || ai.generating}
          onClick={() => void doCommit()}
          data-testid="commit-button"
        >
          {committing ? <Spinner className="size-3.5" /> : <CheckIcon className="size-3.5" />}
          <span className="truncate">{commitLabel}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className={cn(
                "border-l border-primary-foreground/20 px-2",
                !canCommit && "opacity-50 hover:opacity-100",
                touch && "h-11 min-w-11"
              )}
              aria-label={t("commit.more")}
              data-testid="commit-more"
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              disabled={!canCommit || !can("git_push")}
              onSelect={() => void doCommit("push")}
              data-testid="commit-and-push"
            >
              <ArrowUpFromLineIcon className="size-3.5" />
              {t("commit.commitAndPush")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canCommit || !can("git_sync")}
              onSelect={() => void doCommit("sync")}
              data-testid="commit-and-sync"
            >
              <RefreshCwIcon className="size-3.5" />
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
      </ButtonGroup>
      <GitIdentityDialog
        open={identityOpen}
        repoPath={rootDir}
        onOpenChange={setIdentityOpen}
        onSaved={() => doCommit(pendingPostCommit.current, true)}
      />
    </div>
  )
}
