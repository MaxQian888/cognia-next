"use client"

/**
 * The strips that sit between the Source Control header and its body.
 *
 *  - `SequencerBanner`: a merge, rebase, cherry-pick or revert stopped
 *    half-way. Continue and Abort are the only ways out, so they live on the
 *    strip itself rather than in a menu.
 *  - `StaleStatusBanner`: a refresh failed while an earlier snapshot is still
 *    on screen. The list below is honest about being old, with a retry.
 *  - `WriteUnavailableBanner`: this device can read the repository but not
 *    change it (a paired phone without the grant, or the host's approval
 *    lease). Every write control is disabled then; this says why once.
 *
 * Shared by the desktop panel and the phone body. The phone had neither, so a
 * rebase stopped on a conflict left it with no way to continue or abort and a
 * failed refresh looked identical to a clean one.
 *
 * Both slide open and closed (height + opacity) instead of shoving the body
 * down by a full row in one frame; under reduced motion they snap.
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { AlertTriangleIcon, LockIcon, RefreshCwIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { useGitStore } from "@/stores/git/git-store"
import type { GitOperationKind } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"

type Density = "compact" | "touch"

/** Height-and-opacity reveal shared by both strips. */
function Reveal({ show, id, children }: { show: boolean; id: string; children: React.ReactNode }) {
  const transition = useReducedMotionTransition(mobileTransition("fast"))
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key={id}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={transition}
          className="shrink-0 overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface SequencerBannerProps {
  operation: GitOperationKind | null
  actions: Pick<UseGitActionsResult, "sequencerContinue" | "sequencerAbort"> &
    Partial<Pick<UseGitActionsResult, "can">>
  density?: Density
}

export function SequencerBanner({ operation, actions, density = "compact" }: SequencerBannerProps) {
  const t = useTranslations("sourceControl")
  const busy = useGitStore((s) => s.ops.sequence)
  const can = actions.can ?? (() => true)
  const touch = density === "touch"

  return (
    <Reveal show={operation !== null} id="sequencer">
      <Alert
        className={cn("rounded-none border-x-0 border-t-0 px-3", touch ? "py-2" : "py-1.5")}
        data-testid="sequencer-banner"
      >
        <AlertDescription
          className={cn("flex min-w-0 items-center gap-2 text-xs", touch && "flex-wrap")}
        >
          <span className={cn("min-w-0 flex-1", touch ? "basis-full" : "truncate")}>
            {operation ? t(`sequencer.inProgress.${operation}` as never) : null}
          </span>
          <Button
            size="sm"
            variant="outline"
            className={cn("text-xs", touch ? "h-9 flex-1" : "h-6")}
            onClick={() => void actions.sequencerContinue()}
            disabled={busy || !can("git_sequencer_continue")}
            data-testid="sequencer-continue"
          >
            {busy ? <Spinner className="size-3" /> : null}
            {t("sequencer.continue")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={cn("text-xs text-destructive", touch ? "h-9 flex-1" : "h-6")}
            onClick={() => void actions.sequencerAbort()}
            disabled={busy || !can("git_sequencer_abort")}
            data-testid="sequencer-abort"
          >
            {t("sequencer.abort")}
          </Button>
        </AlertDescription>
      </Alert>
    </Reveal>
  )
}

interface StaleStatusBannerProps {
  /** The refresh failure, or null while the snapshot is current. */
  message: string | null
  onRetry: () => void
  density?: Density
}

export function StaleStatusBanner({
  message,
  onRetry,
  density = "compact",
}: StaleStatusBannerProps) {
  const t = useTranslations("sourceControl")
  const touch = density === "touch"

  return (
    <Reveal show={message !== null} id="stale">
      <Alert
        variant="destructive"
        className={cn("rounded-none border-x-0 border-t-0 px-3", touch ? "py-2" : "py-1.5")}
        data-testid="sc-load-error-banner"
      >
        <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
        <AlertDescription className="flex min-w-0 items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={message ?? ""}>
            {t("repository.stale", { message: message ?? "" })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className={cn("shrink-0 px-2 text-xs", touch ? "h-9" : "h-6")}
            onClick={onRetry}
            data-testid="sc-load-error-retry"
          >
            <RefreshCwIcon className="size-3" />
            {t("repository.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    </Reveal>
  )
}

/**
 * Why Pull, Push, Commit, Stash and the rest are greyed out.
 *
 * Those controls gate on `can(command)` and went grey with no word of
 * explanation, so a phone missing the write grant looked broken rather than
 * one switch away. `git_commit` stands for the set: every git write needs the
 * same `git.write` grant and the same approval lease, so one sentence covers
 * them all instead of a tooltip per button that a touch screen cannot show.
 */
export function WriteUnavailableBanner({ density = "compact" }: { density?: Density }) {
  const gate = useWorkspaceCommandGate()
  const verdict = gate("git_commit")
  const touch = density === "touch"

  return (
    <Reveal show={!verdict.available} id="write-unavailable">
      <Alert
        role="status"
        className={cn(
          "rounded-none border-x-0 border-t-0 bg-muted/40 px-3",
          touch ? "py-2" : "py-1.5"
        )}
        data-testid="sc-write-unavailable-banner"
      >
        <LockIcon className="size-3.5 shrink-0" />
        <AlertDescription className="text-xs text-muted-foreground">
          {verdict.reason}
        </AlertDescription>
      </Alert>
    </Reveal>
  )
}
