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
 */

import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, HardDriveIcon, KeyRoundIcon, LinkIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { useCopy } from "@/hooks/ui/use-copy"
import { useProvisioningOffer } from "@/hooks/workspace/use-provisioning-offer"
import {
  PNPM_GLOBAL_STORE_COMMAND,
  type ProvisioningCandidate,
} from "@/lib/workspace/provisioning-inference"

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
    <div
      className="flex items-start justify-between gap-2 rounded border bg-background/70 p-2"
      data-testid={`provisioning-candidate-${candidate.id}`}
    >
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-1.5 font-mono text-[11px]">
          <Icon className="size-3 shrink-0 text-muted-foreground" />
          {t(`candidate.${candidate.kind}`, { path: candidate.path })}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t(`risk.${candidate.riskKey}`, { path: candidate.path })}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {t("evidence", { names: candidate.evidence.join(", ") })}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">{children}</div>
    </div>
  )
}

export function ProjectEnvironmentProvisioning({ projectId, executionRoot, deps }: Props) {
  const t = useTranslations("projectEnvironment.provisioning")
  const { candidates, pending, consent, pnpm, loading, decide } = useProvisioningOffer(
    projectId,
    executionRoot,
    deps
  )
  const { copied, copy } = useCopy()

  const accepted = new Set(consent.accepted)
  const active = candidates.filter((candidate) => accepted.has(candidate.id))
  // A declined proposal is not re-offered, but it must still be findable —
  // otherwise "I clicked no by mistake" has no way back.
  const declined = candidates.filter(
    (candidate) => !accepted.has(candidate.id) && consent.reviewed.includes(candidate.id)
  )

  return (
    <Surface
      layer="raised"
      className="space-y-2 rounded-md border p-3"
      data-testid="project-environment-provisioning"
      data-state={loading ? "loading" : candidates.length ? "offered" : "empty"}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <HardDriveIcon className="size-3.5 shrink-0" />
          {t("title")}
        </p>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      </div>

      {pnpm === "enabled" ? (
        <p className="text-[10px] text-muted-foreground" data-testid="provisioning-pnpm">
          {t("pnpm.enabled")}
        </p>
      ) : pnpm === "available" ? (
        <div className="space-y-1 rounded border border-dashed p-2" data-testid="provisioning-pnpm">
          <p className="text-[10px] text-muted-foreground">{t("pnpm.available")}</p>
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-background/70 px-1.5 py-1 font-mono text-[10px]">
              {PNPM_GLOBAL_STORE_COMMAND}
            </code>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-[10px]"
              onClick={() => void copy(PNPM_GLOBAL_STORE_COMMAND)}
              aria-label={t("pnpm.copy")}
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && !candidates.length ? (
        <p className="text-[11px] text-muted-foreground" data-testid="provisioning-empty">
          {t("empty")}
        </p>
      ) : null}

      {pending.length ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium text-muted-foreground">{t("pendingTitle")}</p>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
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
          {pending.map((candidate) => (
            <CandidateRow key={candidate.id} candidate={candidate}>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[10px]"
                onClick={() => decide([candidate.id], true)}
              >
                {t("accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => decide([candidate.id], false)}
              >
                {t("decline")}
              </Button>
            </CandidateRow>
          ))}
        </div>
      ) : null}

      {active.length ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <p className="text-[10px] font-medium text-muted-foreground">{t("activeTitle")}</p>
            <Badge variant="secondary" className="text-[10px] font-normal">
              {active.length}
            </Badge>
          </div>
          {active.map((candidate) => (
            <CandidateRow key={candidate.id} candidate={candidate}>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => decide([candidate.id], false)}
              >
                {t("remove")}
              </Button>
            </CandidateRow>
          ))}
        </div>
      ) : null}

      {declined.length ? (
        <div className="space-y-1.5" data-testid="provisioning-declined">
          <p className="text-[10px] font-medium text-muted-foreground">{t("declinedTitle")}</p>
          {declined.map((candidate) => (
            <CandidateRow key={candidate.id} candidate={candidate}>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[10px]"
                onClick={() => decide([candidate.id], true)}
              >
                {t("accept")}
              </Button>
            </CandidateRow>
          ))}
        </div>
      ) : null}
    </Surface>
  )
}
