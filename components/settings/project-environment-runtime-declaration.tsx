"use client"

/**
 * "What this repository asks to run in, and who approved it" (ADR-0182).
 *
 * A declared image is something the user did not choose and may never have
 * read, so this card states the verdict in every case — including "declares
 * nothing" — and shows what is being asked for BEFORE the approve button.
 *
 * Approval here is the Host's ledger: it pins the tag to the digest it names
 * now, keys the record on the declaration's own digest, and is refused by the
 * Host unless the caller may manage the workspace. So a change to the file
 * after approval reads as "changed", and needs approving again.
 */

import { useMemo } from "react"
import { builtEnvironmentDeclaration } from "@/lib/project-environment/devcontainer"
import { useTranslations } from "next-intl"
import { CheckIcon, FileWarningIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  ApprovalRecord,
  EnvironmentBuildStatus,
  DeclarationReadResult,
} from "@/lib/project-environment/environment-client"
import { canonicalImageReference } from "@/lib/project-environment/image-reference"
import type { EnvironmentDeclarationVerdict } from "@/lib/project-environment/read-environment-declaration"

interface Props {
  files: DeclarationReadResult | undefined
  declaration: EnvironmentDeclarationVerdict
  approvals: ApprovalRecord[]
  /** False when the deployment has no pool: nothing can be approved there. */
  canApprove: boolean
  busy: boolean
  build?: EnvironmentBuildStatus
  onBuild?(): void
  onCancelBuild?(): void
  onApprove(): void
  onRevoke(approvalId: string): void
}

export function ProjectEnvironmentRuntimeDeclaration({
  files,
  declaration,
  approvals,
  canApprove,
  busy,
  onApprove,
  build,
  onBuild,
  onCancelBuild,
  onRevoke,
}: Props) {
  const t = useTranslations("projectEnvironment.runtime.declaration")
  const active = approvals.filter((record) => record.revokedAt === undefined)
  const current =
    declaration.kind === "declared"
      ? active.find(
          (record) =>
            record.declarationDigest === declaration.digest &&
            record.path === declaration.declaration.path &&
            (!declaration.declaration.build || record.buildKey === build?.record?.buildKey)
        )
      : undefined
  // An approval for the same path under a different digest is the file
  // having changed since someone said yes — which reads very differently
  // from "never approved".
  const stale =
    declaration.kind === "declared" && !current
      ? active.find((record) => record.path === declaration.declaration.path)
      : undefined

  const effective = useMemo(
    () =>
      declaration.kind === "declared" && declaration.declaration.build && build?.record
        ? builtEnvironmentDeclaration(build.record.runtimeConfiguration, declaration.declaration)
        : undefined,
    [declaration, build]
  )
  const displayed = effective?.ok
    ? effective.declaration
    : declaration.kind === "declared"
      ? declaration.declaration
      : undefined

  return (
    <div
      className="space-y-2 rounded-md border bg-background/40 p-3"
      data-testid="project-environment-runtime-declaration"
      data-state={current ? "approved" : stale ? "changed" : declaration.kind}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          {declaration.kind === "restricted" ? (
            <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          ) : current ? (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : declaration.kind === "absent" ? null : (
            <FileWarningIcon className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          )}
          {t("title")}
        </p>
        {current ? (
          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
            {t("approved")}
          </Badge>
        ) : declaration.kind === "declared" ? (
          <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
            {t("pending")}
          </Badge>
        ) : null}
      </div>

      {declaration.kind === "absent" ? (
        <>
          <p className="text-[11px] text-muted-foreground">{t("none")}</p>
          {files && files.searched.length > 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {t("searched", { paths: files.searched.join(", ") })}
            </p>
          ) : null}
        </>
      ) : null}

      {declaration.kind === "restricted" ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-500">{t("restricted")}</p>
      ) : null}

      {declaration.kind === "invalid" ? (
        <ul className="space-y-0.5" data-testid="runtime-declaration-problems">
          <li className="text-[11px] text-amber-600 dark:text-amber-500">
            {t("invalid", { path: declaration.path, count: declaration.problems.length })}
          </li>
          {declaration.problems.map((problem, index) => (
            // The field path and the stable code, verbatim: the grammar is the
            // devcontainer spec's and the code names exactly what was refused.
            <li
              key={`${problem.field}-${index}`}
              className="font-mono text-[10px] text-muted-foreground"
            >
              {problem.field}: {problem.code}
            </li>
          ))}
        </ul>
      ) : null}

      {declaration.kind === "declared" ? (
        <div className="space-y-1.5">
          <p className="break-all text-[11px]">
            {t("declared", {
              path: declaration.declaration.path,
              image: declaration.declaration.build
                ? t("buildImage")
                : declaration.declaration.image
                  ? canonicalImageReference(declaration.declaration.image)
                  : "",
            })}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {t("details", {
              env: Object.keys(displayed?.containerEnv ?? {}).length,
              ports: displayed?.forwardPorts.length ?? 0,
              commands: Object.keys(displayed?.lifecycleCommands ?? {}).length,
            })}
          </p>
          {displayed?.user?.name ? (
            <p className="text-[10px] text-muted-foreground">
              {t("user", { user: displayed.user.name })}
            </p>
          ) : null}
          {declaration.declaration.build ? (
            <div className="space-y-1.5">
              <p className="text-[10px] text-muted-foreground">{t("buildHint")}</p>
              {build ? (
                <p role="status" className="text-[11px]">
                  {t(`buildStatus.${build.status}`)}
                </p>
              ) : null}
              {build?.error ? (
                <p role="alert" className="break-words text-[11px] text-destructive">
                  {build.error}
                </p>
              ) : null}
              {build?.record ? (
                <p className="break-all font-mono text-[10px]">{build.record.imageId}</p>
              ) : null}
              {effective && !effective.ok ? (
                <ul role="alert" className="text-[11px] text-destructive">
                  {effective.problems.map((problem, index) => (
                    <li key={index}>
                      {problem.field}: {problem.code}
                    </li>
                  ))}
                </ul>
              ) : null}
              {effective?.ok ? (
                <details className="text-[11px]">
                  <summary>{t("effectiveRuntime")}</summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                    {JSON.stringify(
                      {
                        containerEnv: effective.declaration.containerEnv,
                        remoteEnv: effective.declaration.remoteEnv,
                        user: effective.declaration.user,
                        lifecycleCommands: effective.declaration.lifecycleCommands,
                        forwardPorts: effective.declaration.forwardPorts,
                        workspaceFolder: effective.declaration.workspaceFolder,
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>
              ) : null}
              {canApprove && onBuild ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={onBuild}>
                  {t("build")}
                </Button>
              ) : null}
              {(build?.status === "queued" || build?.status === "building") && onCancelBuild ? (
                <Button size="sm" variant="ghost" onClick={onCancelBuild}>
                  {t("cancelBuild")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {declaration.notices.length || effective?.notices.length ? (
            <p className="text-[10px] text-muted-foreground">
              {t("ignoredFields", {
                fields: [
                  ...new Set(
                    [...declaration.notices, ...(effective?.notices ?? [])].map(
                      (notice) => notice.field
                    )
                  ),
                ].join(", "),
              })}
            </p>
          ) : null}
          {stale ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-500">{t("changed")}</p>
          ) : null}
          {current ? (
            <p className="text-[10px] text-muted-foreground">
              {t("approvedBy", { who: current.approverUserId })}
            </p>
          ) : canApprove ? (
            <>
              <p className="text-[10px] text-muted-foreground">
                {t(declaration.declaration.build ? "approveBuildHint" : "approveHint")}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={
                  busy ||
                  (Boolean(declaration.declaration.build) &&
                    (build?.status !== "succeeded" ||
                      build.record?.declarationDigest !== declaration.digest ||
                      !effective?.ok))
                }
                onClick={onApprove}
                data-testid="runtime-declaration-approve"
              >
                {t("approve")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {active.length > 0 ? (
        <ul className="space-y-1" data-testid="runtime-declaration-approvals">
          {active.map((record) => (
            <li key={record.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                {record.path} · {record.declarationDigest.slice(0, 12)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onRevoke(record.id)}
                aria-label={t("revokeFor", { path: record.path })}
              >
                {t("revoke")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
