"use client"

/**
 * "A worktree starts empty — here is what we could put back, and what that
 * costs you."
 *
 * A managed worktree is a second checkout with no `node_modules`, no `target`,
 * no `.venv` and no `.env`, so the first turn in one pays a cold install and
 * may not run at all. The native provisioner has always been able to fix that;
 * until now only a repository that committed `.cognia/workspace.json` could ask
 * it to.
 *
 * This card asks on the repository's behalf — and states the price in the same
 * breath, because the price is real. A cache link points the worktree at a
 * directory INSIDE the user's own checkout: a task that installs different
 * dependencies rewrites what the user is working in, and two tasks at once
 * write it together. That is why every row carries its own consequence rather
 * than a shared "are you sure", and why nothing is applied until someone says
 * yes.
 *
 * When pnpm can do better than sharing — its global virtual store gives each
 * worktree its own `node_modules` linked from one place on disk — the card says
 * so and stops proposing the share. The command is shown, not run: it edits a
 * machine-wide config that affects every project on this computer, which is not
 * ours to change from a settings panel.
 *
 * It is one chapter of the environment manager (`ProjectEnvironmentSection`),
 * and its suggestions are rows in hairline-divided lists, not a bordered box
 * per suggestion inside a bordered card.
 */

import { useTranslations } from "next-intl"
import {
  CheckIcon,
  CircleSlashIcon,
  CopyIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LinkIcon,
  RotateCcwIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCopy } from "@/hooks/ui/use-copy"
import { useProvisioningOffer } from "@/hooks/workspace/use-provisioning-offer"
import {
  activeCandidates,
  PNPM_GLOBAL_STORE_COMMAND,
  type ProvisioningCandidate,
} from "@/lib/workspace/provisioning-inference"

import { ProjectEnvironmentSection } from "./project-environment-section"

interface Props {
  projectId: string
  /** The workspace root the proposal is derived from. */
  executionRoot: string
  /** Injected in tests; production takes the hook's own defaults. */
  deps?: Parameters<typeof useProvisioningOffer>[2]
}

function CandidateRow({
  candidate,
  children,
}: {
  candidate: ProvisioningCandidate
  children: React.ReactNode
}) {
  const t = useTranslations("projectEnvironment.provisioning")
  const Icon = candidate.kind === "cacheLink" ? LinkIcon : KeyRoundIcon
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 py-2"
      data-testid={`provisioning-candidate-${candidate.id}`}
    >
      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
        <p className="flex items-start gap-1.5 font-mono text-[11px] break-all">
          <Icon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          {t(`candidate.${candidate.kind}`, { path: candidate.path })}
        </p>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t(`risk.${candidate.riskKey}`, { path: candidate.path })}
        </p>
        <p className="text-[11px] text-muted-foreground/80">
          {t("evidence", { names: candidate.evidence.join(", ") })}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">{children}</div>
    </li>
  )
}

export function ProjectEnvironmentProvisioning({ projectId, executionRoot, deps }: Props) {
  const t = useTranslations("projectEnvironment.provisioning")
  const { candidates, pending, consent, pnpm, loading, decide, unavailable, failed, refresh } =
    useProvisioningOffer(projectId, executionRoot, deps)
  const { copied, copy } = useCopy()

  const accepted = new Set(consent.accepted)
  const active = activeCandidates(candidates, consent)
  // A declined proposal is not re-offered, but it must still be findable —
  // otherwise "I clicked no by mistake" has no way back.
  const declined = candidates.filter(
    (candidate) => !accepted.has(candidate.id) && consent.reviewed.includes(candidate.id)
  )

  return (
    <ProjectEnvironmentSection
      id="provisioning"
      title={t("title")}
      icon={HardDriveIcon}
      meta={active.length > 0 ? active.length : undefined}
    >
      <div
        className="space-y-3"
        data-testid="project-environment-provisioning"
        data-state={
          unavailable !== null
            ? "unavailable"
            : loading
              ? "loading"
              : failed
                ? "failed"
                : candidates.length
                  ? "offered"
                  : "empty"
        }
      >
        <p className="text-[11px] leading-snug text-muted-foreground">{t("description")}</p>

        {pnpm === "enabled" ? (
          <p className="text-[11px] text-muted-foreground" data-testid="provisioning-pnpm">
            {t("pnpm.enabled")}
          </p>
        ) : pnpm === "available" ? (
          // A rule at its edge, not a dashed box: it is an aside to this
          // section, not a second card inside it.
          <div className="space-y-1.5 border-l-2 pl-3" data-testid="provisioning-pnpm">
            <p className="text-[11px] leading-snug text-muted-foreground">{t("pnpm.available")}</p>
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded-control bg-muted/60 px-1.5 py-1 font-mono text-[11px]">
                {PNPM_GLOBAL_STORE_COMMAND}
              </code>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-[11px]"
                onClick={() => void copy(PNPM_GLOBAL_STORE_COMMAND)}
                aria-label={t("pnpm.copy")}
              >
                {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Three different empties: this device cannot look, the look
            failed, or it looked and found nothing. Only the last is a
            statement about the repository. */}
        {unavailable !== null ? (
          <p
            className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground"
            data-testid="provisioning-unavailable"
          >
            <CircleSlashIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0">
              {t("unavailable")} {unavailable}
            </span>
          </p>
        ) : !loading && failed ? (
          <div className="space-y-1.5" data-testid="provisioning-failed">
            <p className="text-xs text-amber-700 dark:text-amber-400">{t("failed")}</p>
            <Button size="sm" variant="outline" className="h-7" onClick={refresh}>
              <RotateCcwIcon className="size-3.5" />
              {t("retry")}
            </Button>
          </div>
        ) : !loading && !candidates.length ? (
          <p className="text-xs text-muted-foreground" data-testid="provisioning-empty">
            {t("empty")}
          </p>
        ) : null}

        {pending.length ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("pendingTitle")}</p>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  decide(
                    pending.map((candidate) => candidate.id),
                    true
                  )
                }
                data-testid="provisioning-accept-all"
              >
                {t("acceptAll")}
              </Button>
            </div>
            <ul className="divide-y border-y">
              {pending.map((candidate) => (
                <CandidateRow key={candidate.id} candidate={candidate}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => decide([candidate.id], true)}
                  >
                    {t("accept")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => decide([candidate.id], false)}
                  >
                    {t("decline")}
                  </Button>
                </CandidateRow>
              ))}
            </ul>
          </div>
        ) : null}

        {active.length ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">{t("activeTitle")}</p>
              <Badge variant="secondary" className="text-[10px] font-normal">
                {active.length}
              </Badge>
            </div>
            <ul className="divide-y border-y">
              {active.map((candidate) => (
                <CandidateRow key={candidate.id} candidate={candidate}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => decide([candidate.id], false)}
                  >
                    {t("remove")}
                  </Button>
                </CandidateRow>
              ))}
            </ul>
          </div>
        ) : null}

        {declined.length ? (
          <div className="space-y-1.5" data-testid="provisioning-declined">
            <p className="text-[11px] font-medium text-muted-foreground">{t("declinedTitle")}</p>
            <ul className="divide-y border-y">
              {declined.map((candidate) => (
                <CandidateRow key={candidate.id} candidate={candidate}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => decide([candidate.id], true)}
                  >
                    {t("accept")}
                  </Button>
                </CandidateRow>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </ProjectEnvironmentSection>
  )
}
