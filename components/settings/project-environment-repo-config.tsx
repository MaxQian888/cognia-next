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
 */

import { useTranslations } from "next-intl"
import { CheckIcon, FileWarningIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useRepoWorkspaceConfig } from "@/hooks/workspace/use-repo-workspace-config"
import type { WorkspaceRepositoryConfigV1 } from "@/lib/project-environment/workspace-config"
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
          <p className="text-[10px] font-medium text-muted-foreground">{t("declaredSetup")}</p>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-relaxed">
            {setup}
          </pre>
        </div>
      ) : null}
      <p className="text-[10px] text-muted-foreground">
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
        <p className="text-[10px] text-muted-foreground">
          {t("requiredSecrets", { names: config.requiredSecrets.join(", ") })}
        </p>
      ) : null}
    </div>
  )
}

export function ProjectEnvironmentRepoConfig({ projectId, executionRoot, deps }: Props) {
  const t = useTranslations("projectEnvironment.repoConfig")
  const { verdict, loading, approving, approve } = useRepoWorkspaceConfig(
    projectId,
    executionRoot,
    deps
  )

  // Two states share `unapproved` and read very differently to a user: never
  // seen, versus edited since you said yes.
  const changed = verdict.kind === "unapproved" && Boolean(verdict.approvedDigest)
  const statusKey = changed ? "changed" : verdict.kind
  const tone =
    verdict.kind === "approved"
      ? "text-muted-foreground"
      : verdict.kind === "absent"
        ? "text-muted-foreground"
        : "text-amber-600 dark:text-amber-500"

  return (
    <div
      className="space-y-2 rounded-md border bg-background/40 p-3"
      data-testid="project-environment-repo-config"
      data-state={loading ? "loading" : statusKey}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            {verdict.kind === "restricted" ? (
              <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
            ) : verdict.kind === "approved" ? (
              <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
            ) : verdict.kind === "absent" ? null : (
              <FileWarningIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
            )}
            {t("title")}
          </p>
          <p className="text-[10px] text-muted-foreground">{t("description")}</p>
        </div>
        {verdict.kind === "approved" ? (
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            {t("approved")}
          </Badge>
        ) : null}
      </div>

      <p className={cn("text-[11px]", tone)} data-testid="repo-config-status">
        {verdict.kind === "invalid"
          ? t("status.invalid", { message: `${verdict.field}: ${verdict.message}` })
          : t(`status.${statusKey}`)}
      </p>

      {verdict.kind === "restricted" ? (
        <p className="text-[10px] text-muted-foreground">{t("untrustedHint")}</p>
      ) : null}

      {verdict.kind === "unapproved" ? (
        <>
          <Declared config={verdict.config} />
          <Button
            size="sm"
            variant="outline"
            className="w-full"
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
