"use client"

/**
 * "What this repository ships, and whether it is running."
 *
 * `.cognia/workspace.json` is a file the user did not write and may never have
 * opened. Applying it silently would be the wrong kind of convenient, and
 * refusing it silently would be indistinguishable from the feature not
 * existing — so this card always states the verdict, including the boring one.
 *
 * When approval is pending it shows what is being asked for BEFORE the button,
 * because "Approve" is meaningless next to a filename. The counts are the
 * shape; the setup script is the part that actually runs, so it is shown
 * verbatim rather than summarized.
 *
 * Two layers: `ProjectEnvironmentRepoConfigView` renders a verdict it is
 * handed, and `ProjectEnvironmentRepoConfig` reads one itself. The environment
 * manager uses the view, because it needs the same verdict to tell its editor
 * what the repository replaces, and reading it twice would be two reads of one
 * file that could disagree. Neither draws a frame: the host's section heading
 * names it.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, CircleSlashIcon, FileWarningIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  useRepoWorkspaceConfig,
  type RepoWorkspaceConfigState,
} from "@/hooks/workspace/use-repo-workspace-config"
import type { WorkspaceRepositoryConfigV1 } from "@/lib/project-environment/workspace-config"
import {
  diffWorkspaceConfig,
  type WorkspaceConfigChange,
} from "@/lib/project-environment/workspace-config-diff"
import { cn } from "@/lib/utils"

interface Props {
  projectId: string
  /** Where the file is read from — the same root the environment runs in. */
  executionRoot: string
  /** Injected in tests; production takes the hook's own defaults. */
  deps?: Parameters<typeof useRepoWorkspaceConfig>[2]
}

function countCapabilities(config: WorkspaceRepositoryConfigV1): number {
  return Object.values(config.capabilities).reduce(
    (total, byId) => total + Object.keys(byId ?? {}).length,
    0
  )
}

/** The declared shape, as short factual lines rather than a rendered form. */
function Declared({ config }: { config: WorkspaceRepositoryConfigV1 }) {
  const t = useTranslations("projectEnvironment.repoConfig")
  const setup = config.setup.default.trim()
  const capabilityCount = countCapabilities(config)
  const rows: string[] = []
  if (config.actions.length) rows.push(t("declaredActions", { count: config.actions.length }))
  const variableCount = Object.keys(config.variables).length
  if (variableCount) rows.push(t("declaredVariables", { count: variableCount }))
  if (config.roots.length) rows.push(t("declaredRoots", { count: config.roots.length }))
  if (capabilityCount) rows.push(t("declaredCapabilities", { count: capabilityCount }))

  return (
    <div className="space-y-2" data-testid="repo-config-declared">
      {setup ? (
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">{t("declaredSetup")}</p>
          <pre className="mt-1 max-h-40 overflow-auto rounded-control bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
            {setup}
          </pre>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {t("declaredExecution")}:{" "}
        {config.defaults.execution === "worktree" ? t("executionWorktree") : t("executionLocal")}
      </p>
      {rows.length ? (
        <div className="flex flex-wrap gap-1">
          {rows.map((row) => (
            <Badge key={row} variant="secondary" className="text-[10px] font-normal">
              {row}
            </Badge>
          ))}
        </div>
      ) : null}
      {config.requiredSecrets.length ? (
        <p className="text-[11px] text-muted-foreground">
          {t("requiredSecrets", { names: config.requiredSecrets.join(", ") })}
        </p>
      ) : null}
    </div>
  )
}

const KIND_TONE: Record<WorkspaceConfigChange["kind"], string> = {
  added: "text-emerald-700 dark:text-emerald-400",
  removed: "text-destructive",
  changed: "text-amber-700 dark:text-amber-400",
}

/**
 * One value of a change: the approved one or the current one, verbatim.
 *
 * Filled, not framed: a script needs a ground to be read on, and a border
 * here would be a box inside a list inside a section.
 */
function ChangeValue({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <pre
        className={cn(
          "mt-0.5 max-h-40 overflow-auto rounded-control px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all",
          tone
        )}
      >
        {value}
      </pre>
    </div>
  )
}

/**
 * What changed since the approved version, one row per thing that can run or
 * take effect, each with the approved and the current value side by side
 * (stacked on a narrow pane). The review question is "what is different",
 * and the whole current file answered it only for a reader with the old one
 * memorised.
 */
function ConfigChanges({
  previous,
  current,
}: {
  previous: WorkspaceRepositoryConfigV1
  current: WorkspaceRepositoryConfigV1
}) {
  const t = useTranslations("projectEnvironment.repoConfig")
  const changes = diffWorkspaceConfig(previous, current)
  const display = (change: WorkspaceConfigChange, value: string) =>
    change.field === "execution"
      ? value === "worktree"
        ? t("executionWorktree")
        : t("executionLocal")
      : change.field === "capability"
        ? t(value === "on" ? "diff.on" : "diff.off")
        : value
  const label = (change: WorkspaceConfigChange) =>
    change.field === "setupOs"
      ? t("diff.field.setupOs", {
          os: t(`diff.os.${change.subject as "macos" | "windows" | "linux"}`),
        })
      : t(`diff.field.${change.field}`, { subject: change.subject ?? "" })

  return (
    <div className="@container/repo-diff space-y-2" data-testid="repo-config-changes">
      <p className="text-xs font-medium">{t("diff.title")}</p>
      {changes.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("diff.empty")}</p>
      ) : (
        <ul className="divide-y border-y">
          {changes.map((change) => (
            <li
              key={change.id}
              className="space-y-1.5 py-2"
              data-testid={`repo-config-change-${change.id}`}
              data-kind={change.kind}
            >
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="min-w-0 break-words font-medium">{label(change)}</span>
                <span className={cn("text-[11px]", KIND_TONE[change.kind])}>
                  {t(`diff.kind.${change.kind}`)}
                </span>
              </p>
              <div className="grid gap-2 @md/repo-diff:grid-cols-2">
                {change.before !== undefined ? (
                  <ChangeValue
                    label={t("diffPrevious")}
                    value={display(change, change.before)}
                    tone={
                      change.kind === "removed"
                        ? "bg-destructive/10 text-destructive line-through decoration-destructive/40"
                        : "bg-muted/60"
                    }
                  />
                ) : null}
                {change.after !== undefined ? (
                  <ChangeValue
                    label={t("diffCurrent")}
                    value={display(change, change.after)}
                    tone={change.kind === "added" ? "bg-emerald-500/10" : "bg-amber-500/10"}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ProjectEnvironmentRepoConfig({ projectId, executionRoot, deps }: Props) {
  const state = useRepoWorkspaceConfig(projectId, executionRoot, deps)
  return <ProjectEnvironmentRepoConfigView state={state} />
}

export function ProjectEnvironmentRepoConfigView({ state }: { state: RepoWorkspaceConfigState }) {
  const t = useTranslations("projectEnvironment.repoConfig")
  const { verdict, loading, approving, approve, unavailable } = state

  // Not a verdict about the repository: this runtime has no way to read the
  // file, and saying "could not be read" here made a healthy repository look
  // broken. The reason is the gate's own sentence.
  if (unavailable !== null) {
    return (
      <div
        className="space-y-2.5"
        data-testid="project-environment-repo-config"
        data-state="unavailable"
      >
        <p className="text-[11px] leading-snug text-muted-foreground">{t("description")}</p>
        <p
          className="flex items-start gap-1.5 text-xs leading-snug text-muted-foreground"
          data-testid="repo-config-status"
        >
          <CircleSlashIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">
            {t("unavailable")} {unavailable}
          </span>
        </p>
      </div>
    )
  }

  // Two states share `unapproved` and read very differently to a user: never
  // seen, versus edited since you said yes.
  const changed = verdict.kind === "unapproved" && Boolean(verdict.approvedDigest)
  const statusKey = changed ? "changed" : verdict.kind
  const tone =
    verdict.kind === "approved" || verdict.kind === "absent"
      ? "text-muted-foreground"
      : "text-amber-700 dark:text-amber-400"

  return (
    <div
      className="space-y-2.5"
      data-testid="project-environment-repo-config"
      data-state={loading ? "loading" : statusKey}
    >
      <p className="text-[11px] leading-snug text-muted-foreground">{t("description")}</p>

      {/* The verdict leads, with the icon that says which kind of news it is. */}
      <p
        className={cn("flex items-start gap-1.5 text-xs leading-snug", tone)}
        data-testid="repo-config-status"
      >
        {verdict.kind === "restricted" ? (
          <ShieldAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        ) : verdict.kind === "approved" ? (
          <CheckIcon
            aria-hidden
            className="mt-px size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500"
          />
        ) : verdict.kind === "absent" ? null : (
          <FileWarningIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        )}
        <span className="min-w-0 break-words">
          {verdict.kind === "invalid"
            ? t("status.invalid", { message: `${verdict.field}: ${verdict.message}` })
            : t(`status.${statusKey}`)}
        </span>
        {verdict.kind === "approved" ? (
          <Badge variant="outline" className="ml-auto shrink-0 text-[10px] font-normal">
            {t("approved")}
          </Badge>
        ) : null}
      </p>

      {verdict.kind === "restricted" ? (
        <p className="text-[11px] text-muted-foreground">{t("untrustedHint")}</p>
      ) : null}

      {verdict.kind === "unapproved" ? (
        <>
          {changed ? (
            verdict.approvedConfig ? (
              <ConfigChanges previous={verdict.approvedConfig} current={verdict.config} />
            ) : (
              <p
                className="text-[11px] leading-snug text-muted-foreground"
                data-testid="repo-config-no-previous"
              >
                {t("diff.noPrevious")}
              </p>
            )
          ) : null}
          {changed && verdict.approvedConfig ? (
            // The full current file is still there for a reviewer who wants
            // it, folded under the changes rather than competing with them.
            <details className="group/full">
              <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                {t("diff.currentFull")}
              </summary>
              <div className="mt-2">
                <Declared config={verdict.config} />
              </div>
            </details>
          ) : (
            <Declared config={verdict.config} />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={approving}
            onClick={() => void approve()}
            data-testid="repo-config-approve"
          >
            {changed ? t("reviewChanges") : t("approve")}
          </Button>
        </>
      ) : null}

      {verdict.kind === "approved" ? <Declared config={verdict.config} /> : null}
    </div>
  )
}
