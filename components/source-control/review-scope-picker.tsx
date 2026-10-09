"use client"

/**
 * The one control that says which diff a review shows: Last turn / a chosen
 * turn, This conversation, Uncommitted / Unstaged / Staged, a commit, or the
 * branch against a base. Shared by the dock's review and the Source Control
 * review sheet, so the two never disagree about what a scope means.
 *
 * Turns come from the conversation's Task Workspace record
 * (`useSessionTurnReviews`); commits and branches are read when the menu opens,
 * so a closed picker costs nothing.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSessionTurnReviews, type TurnReviewOption } from "@/hooks/git/use-session-turn-reviews"
import { gitBranches, gitDefaultBranch, gitLog } from "@/lib/git/commands"
import { sameScopeChoice } from "@/lib/review/scope"
import { cn } from "@/lib/utils"
import type { GitCommit } from "@/types/git"
import type { ReviewScopeChoice } from "@/types/review"

/** How many recent commits the Committed submenu offers. */
export const SCOPE_PICKER_COMMIT_LIMIT = 20

export interface ReviewScopePickerProps {
  value: ReviewScopeChoice
  onChange: (next: ReviewScopeChoice) => void
  /** Repository the commit and branch lists are read from. */
  rootDir: string
  /** Conversation whose turns are offered; without one there are none. */
  sessionId?: string | null
  /** Offer "This conversation" (the working tree narrowed to its paths). */
  allowConversation?: boolean
  /** File counts shown beside the working-tree scopes, when the host has them. */
  counts?: Partial<Record<"uncommitted" | "conversation" | "unstaged" | "staged", number>>
  density?: "compact" | "touch"
  className?: string
}

interface RefLists {
  commits: GitCommit[]
  /** Branches to compare HEAD against, trunk first. */
  bases: string[]
  failed: boolean
}

function shortRef(sha: string): string {
  return sha.slice(0, 7)
}

/** A stable string for a choice, so the menu can be one radio group. */
export function scopeChoiceKey(choice: ReviewScopeChoice): string {
  switch (choice.scope) {
    case "lastTurn":
      return `turn:${choice.runId}`
    case "commit":
      return `commit:${choice.commitSha}`
    case "branch":
      return `branch:${choice.baseRef}...${choice.targetRef}`
    default:
      return choice.scope
  }
}

export function ReviewScopePicker({
  value,
  onChange,
  rootDir,
  sessionId = null,
  allowConversation = false,
  counts,
  density = "compact",
  className,
}: ReviewScopePickerProps) {
  const t = useTranslations("unifiedReview.scopePicker")
  const turns = useSessionTurnReviews(sessionId)
  const latest = turns[0] ?? null
  const [refs, setRefs] = useState<RefLists | null>(null)
  const [loading, setLoading] = useState(false)

  const loadRefs = useCallback(async () => {
    setLoading(true)
    try {
      const [commits, branches, trunk] = await Promise.all([
        gitLog(rootDir, SCOPE_PICKER_COMMIT_LIMIT, 0),
        gitBranches(rootDir),
        gitDefaultBranch(rootDir),
      ])
      const current = branches.find((branch) => branch.isCurrent)?.name
      const names = branches
        .map((branch) => branch.name)
        .filter((name) => name !== current && !name.endsWith("/HEAD"))
      const bases = [
        ...(trunk.exists && trunk.branch !== current ? [trunk.branch] : []),
        ...names.filter((name) => name !== trunk.branch),
      ]
      setRefs({ commits, bases, failed: false })
    } catch {
      setRefs({ commits: [], bases: [], failed: true })
    } finally {
      setLoading(false)
    }
  }, [rootDir])

  const turnLabel = (turn: TurnReviewOption) =>
    turn.prompt
      ? t("turnWithPrompt", { ordinal: turn.ordinal, prompt: turn.prompt })
      : t("turn", { ordinal: turn.ordinal })

  const label = (() => {
    switch (value.scope) {
      case "lastTurn": {
        if (latest && latest.runId === value.runId) return t("lastTurn")
        const turn = turns.find((candidate) => candidate.runId === value.runId)
        return turn ? t("turn", { ordinal: turn.ordinal }) : t("aTurn")
      }
      case "commit":
        return t("commitValue", { sha: shortRef(value.commitSha) })
      case "branch":
        return t("branchValue", { base: value.baseRef })
      default:
        return t(value.scope)
    }
  })()

  const pick = (next: ReviewScopeChoice) => {
    if (!sameScopeChoice(next, value)) onChange(next)
  }
  const touch = density === "touch"
  const item = cn("gap-2", touch && "min-h-11")
  const count = (key: keyof NonNullable<ReviewScopePickerProps["counts"]>) =>
    typeof counts?.[key] === "number" ? (
      <span className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">{counts[key]}</span>
    ) : null

  const workingTree = (scope: "uncommitted" | "unstaged" | "staged" | "conversation") => (
    <DropdownMenuRadioItem
      key={scope}
      value={scope}
      className={item}
      data-testid={`review-scope-${scope}`}
      onSelect={() => pick({ scope })}
    >
      {t(scope)}
      {count(scope)}
    </DropdownMenuRadioItem>
  )

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void loadRefs()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "gap-1 rounded-full bg-muted/50 px-3 font-medium",
            touch ? "h-10" : "h-7 text-xs",
            className
          )}
          aria-label={t("label", { scope: label })}
          data-testid="review-scope-trigger"
        >
          <span className="max-w-[16rem] truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" data-testid="review-scope-menu">
        <DropdownMenuRadioGroup value={scopeChoiceKey(value)}>
          <DropdownMenuRadioItem
            value={latest ? scopeChoiceKey({ scope: "lastTurn", runId: latest.runId }) : "turn:"}
            className={item}
            disabled={!latest}
            data-testid="review-scope-last-turn"
            onSelect={() => latest && pick({ scope: "lastTurn", runId: latest.runId })}
          >
            {t("lastTurn")}
            {latest ? null : (
              <span className="ml-auto pl-3 text-xs text-muted-foreground">{t("noTurns")}</span>
            )}
          </DropdownMenuRadioItem>
          {turns.length > 1 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={item} data-testid="review-scope-turns">
                {t("earlierTurns")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
                {turns.map((turn) => (
                  <DropdownMenuRadioItem
                    key={turn.runId}
                    value={scopeChoiceKey({ scope: "lastTurn", runId: turn.runId })}
                    className={cn(item, "flex-col items-start gap-0.5")}
                    data-testid={`review-scope-turn-${turn.ordinal}`}
                    onSelect={() => pick({ scope: "lastTurn", runId: turn.runId })}
                  >
                    <span className="w-full truncate">{turnLabel(turn)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("turnStats", { files: turn.files })}{" "}
                      <span className="text-emerald-600 dark:text-emerald-400">+{turn.added}</span>{" "}
                      <span className="text-red-600 dark:text-red-400">−{turn.removed}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuSeparator />
          {allowConversation ? workingTree("conversation") : null}
          {workingTree("uncommitted")}
          {workingTree("unstaged")}
          {workingTree("staged")}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={item} data-testid="review-scope-commits">
              {t("commit")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-80 overflow-y-auto">
              {loading && !refs ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("loading")}
                </DropdownMenuLabel>
              ) : refs?.failed ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("refsFailed")}
                </DropdownMenuLabel>
              ) : refs && refs.commits.length === 0 ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("noCommits")}
                </DropdownMenuLabel>
              ) : (
                refs?.commits.map((commit) => (
                  <DropdownMenuRadioItem
                    key={commit.hash}
                    value={scopeChoiceKey({ scope: "commit", commitSha: commit.hash })}
                    className={item}
                    data-testid={`review-scope-commit-${commit.shortHash}`}
                    onSelect={() => pick({ scope: "commit", commitSha: commit.hash })}
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {commit.shortHash}
                    </span>
                    <span className="min-w-0 truncate">{commit.summary}</span>
                  </DropdownMenuRadioItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={item} data-testid="review-scope-branches">
              {t("branch")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {t("branchHint")}
              </DropdownMenuLabel>
              {loading && !refs ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("loading")}
                </DropdownMenuLabel>
              ) : refs?.failed ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("refsFailed")}
                </DropdownMenuLabel>
              ) : refs && refs.bases.length === 0 ? (
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("noBranches")}
                </DropdownMenuLabel>
              ) : (
                refs?.bases.map((base) => (
                  <DropdownMenuRadioItem
                    key={base}
                    value={scopeChoiceKey({ scope: "branch", baseRef: base, targetRef: "HEAD" })}
                    className={item}
                    data-testid={`review-scope-branch-${base}`}
                    onSelect={() => pick({ scope: "branch", baseRef: base, targetRef: "HEAD" })}
                  >
                    <span className="min-w-0 truncate font-mono text-xs">{base}</span>
                  </DropdownMenuRadioItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
