"use client"

// Pi packages shipped by Cognia plugins (ADR-0210) — one component shared by
// the plugin detail page (narrowed to one plugin) and the Agent packages pane
// (every enabled plugin).
//
// What each row must say before the user acts, because none of it is visible
// from Pi's side:
//
//   - whether the package's dependency step has run (Pi never installs
//     dependencies for a local package), with the exact command behind a
//     confirmation before anything is spawned;
//   - where it is installed, per scope, matched by Pi's own identity rule;
//   - that installing without a reachable Pi only records intent (degraded);
//   - whether Pi agents can load it in hosted sessions, which tools it adds,
//     and whether it takes over the session's tool surface.

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  HammerIcon,
  PackageIcon,
  PlugZapIcon,
  TerminalIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  useContributedPiPackages,
  type ContributedPiPackageView,
} from "@/hooks/plugins/use-contributed-pi-packages"
import type { UsePiPackagesResult } from "@/hooks/plugins/use-pi-packages"
import { satisfiesMinVersion } from "@/lib/cli-bridge/detect-cli"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import {
  installPiPackage,
  piPackageInstallStateFromSnapshot,
  preparePiPackage,
  removePiPackage,
  type PiPackagePreparePlan,
} from "@/lib/plugin/pi-packages/operations"
import { piPackageErrorKey } from "@/lib/plugin/pi-packages/error-keys"
import type { PiPackagePrepareState } from "@/lib/plugin/pi-packages/resolve"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import type { PiPackageScope } from "@/lib/pi-packages/types"

const PREPARE_STATUS_KEYS: Record<PiPackagePrepareState, string> = {
  "not-required": "notRequired",
  prepared: "prepared",
  missing: "missing",
  unverifiable: "unverifiable",
  unknown: "unknown",
}

interface PendingPrepare {
  plan: PiPackagePreparePlan
  thenInstall: boolean
  resolve: (approved: boolean) => void
}

export interface ContributedPiPackageListProps {
  /** Narrow to one plugin's packages (the plugin detail page). */
  pluginId?: string
  /** The shared Pi snapshot (CLI availability, both scopes, workspace). */
  pi: UsePiPackagesResult
}

export function ContributedPiPackageList({ pluginId, pi }: ContributedPiPackageListProps) {
  const t = useTranslations("plugins.piPackages")
  const tAll = useTranslations()
  const { packages, loading, refresh } = useContributedPiPackages(pluginId)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingPrepare | null>(null)

  const cli = pi.snapshot?.cli ?? { available: false }
  const cwd = pi.snapshot?.projectCwd ?? null

  /**
   * The localized reason for a failure code. The runtime's English sentence
   * never reaches the UI as the message — only as the toast's details line.
   */
  const describeError = useCallback(
    (code: string | undefined, params: Record<string, string | number> = {}): string =>
      t(`errors.${piPackageErrorKey(code, "executionFailed")}`, params),
    [t]
  )

  const displayName = useCallback(
    (view: ContributedPiPackageView) =>
      resolvePluginLabel(tAll, view.entry.pluginId, view.entry.def.nameKey, view.entry.def.name),
    [tAll]
  )

  const scopeLabel = useCallback(
    (scope: PiPackageScope) =>
      scope === "user" ? t("install.scopeUser") : t("install.scopeProject"),
    [t]
  )

  /** Ask the user, through the dialog, to approve the exact prepare command. */
  const confirmPrepare = useCallback(
    (plan: PiPackagePreparePlan, thenInstall: boolean) =>
      new Promise<boolean>((resolve) => {
        setPending({ plan, thenInstall, resolve })
      }),
    []
  )

  const settlePending = useCallback(
    (approved: boolean) => {
      pending?.resolve(approved)
      setPending(null)
    },
    [pending]
  )

  async function install(view: ContributedPiPackageView, scope: PiPackageScope): Promise<void> {
    const name = displayName(view)
    setBusy(`${view.entry.ref}:install:${scope}`)
    try {
      const outcome = await installPiPackage(view.entry.ref, scope, { cwd, cli })
      if (outcome.code === "needs-prepare") {
        // Offer the prepare step, then continue the install the user asked for.
        setBusy(null)
        await prepare(view, scope)
        return
      }
      if (outcome.ok) {
        toast.success(
          outcome.degradedReason
            ? t("install.successDegradedToast", { name, scope: scopeLabel(scope) })
            : t("install.successToast", { name, scope: scopeLabel(scope) })
        )
        await pi.reload()
      } else {
        toast.error(t("install.failureToast", { name, message: describeError(outcome.code) }), {
          description: failureDetails(outcome.output, outcome.error),
        })
      }
    } finally {
      setBusy(null)
    }
  }

  async function prepare(
    view: ContributedPiPackageView,
    thenInstall?: PiPackageScope
  ): Promise<void> {
    const name = displayName(view)
    setBusy(`${view.entry.ref}:prepare`)
    try {
      const outcome = await preparePiPackage(view.entry.ref, {
        confirm: (plan) => confirmPrepare(plan, Boolean(thenInstall)),
      })
      refresh()
      if (outcome.code === "declined") return
      if (!outcome.ok) {
        const plan = outcome.plan
        toast.error(
          t("prepare.failureToast", {
            name,
            message: describeError(outcome.code, {
              program: plan?.program ?? "",
              code: outcome.exitCode ?? "?",
              seconds: plan ? Math.round(plan.timeoutMs / 1000) : 0,
              path: outcome.link ?? "",
            }),
          }),
          { description: failureDetails(outcome.output, outcome.error) }
        )
        return
      }
      toast.success(t("prepare.successToast", { name }))
      if (thenInstall) {
        setBusy(null)
        await install(view, thenInstall)
      }
    } finally {
      setBusy(null)
    }
  }

  async function remove(view: ContributedPiPackageView, scope: PiPackageScope): Promise<void> {
    const name = displayName(view)
    setBusy(`${view.entry.ref}:remove:${scope}`)
    try {
      const outcome = await removePiPackage(view.entry.ref, scope, { cwd, cli })
      if (outcome.ok) {
        toast.success(t("install.removeSuccessToast", { name, scope: scopeLabel(scope) }))
        await pi.reload()
      } else {
        toast.error(
          t("install.removeFailureToast", { name, message: describeError(outcome.code) }),
          {
            description: failureDetails(outcome.output, outcome.error),
          }
        )
      }
    } finally {
      setBusy(null)
    }
  }

  if (packages.length === 0) return null

  return (
    <div className="space-y-2" data-testid="contributed-pi-packages">
      {!pi.loading && !cli.available && (
        <Alert data-testid="contributed-pi-packages-degraded">
          <TerminalIcon className="size-4" />
          <AlertDescription className="text-xs">{t("install.degraded")}</AlertDescription>
        </Alert>
      )}
      <ul className="space-y-2">
        {packages.map((view) => (
          <ContributedPiPackageRow
            key={view.entry.ref}
            view={view}
            name={displayName(view)}
            description={
              view.entry.def.descriptionKey || view.entry.def.description
                ? resolvePluginLabel(
                    tAll,
                    view.entry.pluginId,
                    view.entry.def.descriptionKey,
                    view.entry.def.description ?? ""
                  )
                : ""
            }
            showPlugin={!pluginId}
            loading={loading}
            pi={pi}
            busy={busy}
            describeError={describeError}
            onPrepare={() => void prepare(view)}
            onInstall={(scope) => void install(view, scope)}
            onRemove={(scope) => void remove(view, scope)}
          />
        ))}
      </ul>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && settlePending(false)}>
        <AlertDialogContent data-testid="pi-package-prepare-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("prepare.dialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              <PrepareDialogDescription pluginId={pending?.plan.pluginId ?? null} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending && (
            <div className="space-y-2 text-xs">
              <div>
                <div className="text-muted-foreground">{t("prepare.commandLabel")}</div>
                <code
                  className="bg-muted block rounded px-2 py-1 font-mono break-all"
                  data-testid="pi-package-prepare-command"
                >
                  {pending.plan.commandLine}
                </code>
              </div>
              <div>
                <div className="text-muted-foreground">{t("prepare.cwdLabel")}</div>
                <code className="bg-muted block rounded px-2 py-1 font-mono break-all">
                  {pending.plan.cwd}
                </code>
              </div>
              <p className="text-muted-foreground">
                {t("prepare.timeout", { seconds: Math.round(pending.plan.timeoutMs / 1000) })}
              </p>
              {pending.thenInstall && <p>{t("prepare.thenInstall")}</p>}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settlePending(false)}>
              {t("prepare.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settlePending(true)}
              data-testid="pi-package-prepare-confirm"
            >
              {t("prepare.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * What the toast's details line shows: Pi's or the package manager's own
 * output when there is any (the last part, which is where the error is),
 * otherwise the runtime's sentence. Data, not UI copy — it is never localized.
 */
function failureDetails(output: string | undefined, error: string | undefined): string | undefined {
  const text = output?.trim() || error?.trim()
  if (!text) return undefined
  return text.length > 600 ? `…${text.slice(-600)}` : text
}

function PrepareDialogDescription({ pluginId }: { pluginId: string | null }) {
  const t = useTranslations("plugins.piPackages")
  const plugin = usePluginDisplayName(pluginId)
  return <>{t("prepare.dialogDescription", { plugin })}</>
}

interface RowProps {
  view: ContributedPiPackageView
  name: string
  description: string
  showPlugin: boolean
  loading: boolean
  pi: UsePiPackagesResult
  busy: string | null
  describeError: (code: string | undefined, params?: Record<string, string | number>) => string
  onPrepare: () => void
  onInstall: (scope: PiPackageScope) => void
  onRemove: (scope: PiPackageScope) => void
}

function ContributedPiPackageRow({
  view,
  name,
  description,
  showPlugin,
  loading,
  pi,
  busy,
  describeError,
  onPrepare,
  onInstall,
  onRemove,
}: RowProps) {
  const t = useTranslations("plugins.piPackages")
  const pluginName = usePluginDisplayName(view.entry.pluginId)
  const { entry, resolved, error } = view
  const def = entry.def
  const testId = `contributed-pi-package-${entry.ref.replace(/[^a-z0-9-]/gi, "-")}`
  const installState =
    resolved && pi.snapshot
      ? piPackageInstallStateFromSnapshot(resolved.packageDir, pi.snapshot)
      : null
  const piVersion = pi.snapshot?.cli.version
  const versionUnmet =
    Boolean(def.minPiVersion && piVersion) &&
    !satisfiesMinVersion(piVersion ?? null, def.minPiVersion)
  const rowBusy = busy?.startsWith(`${entry.ref}:`) ?? false
  const anyBusy = busy !== null

  return (
    <li>
      <Card className="space-y-2 p-3" data-testid={testId}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5">
              <PackageIcon className="size-3.5 shrink-0" />
              <span className="text-sm font-medium">{name}</span>
              {showPlugin && (
                <Badge variant="outline" className="text-[10px]">
                  {t("fromPlugin", { plugin: pluginName })}
                </Badge>
              )}
            </div>
            {description && <p className="text-muted-foreground text-xs">{description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {def.minPiVersion && (
              <Badge
                variant={versionUnmet ? "destructive" : "outline"}
                className="font-mono text-[10px]"
                data-testid={`${testId}-min-version`}
              >
                {versionUnmet
                  ? t("minPiVersionUnmet", {
                      version: def.minPiVersion,
                      installed: piVersion ?? "",
                    })
                  : t("minPiVersion", { version: def.minPiVersion })}
              </Badge>
            )}
            {resolved && (
              <Badge
                variant={
                  resolved.prepareState === "missing" || resolved.prepareState === "unknown"
                    ? "destructive"
                    : "outline"
                }
                className="text-[10px]"
                data-testid={`${testId}-prepare-state`}
              >
                {t(`prepare.status.${PREPARE_STATUS_KEYS[resolved.prepareState]}`)}
              </Badge>
            )}
          </div>
        </div>

        {error ? (
          <Alert variant="destructive" data-testid={`${testId}-error`}>
            <AlertTriangleIcon className="size-4" />
            <AlertDescription className="text-xs">{describeError(error.code)}</AlertDescription>
          </Alert>
        ) : !resolved ? (
          loading && <p className="text-muted-foreground text-xs">{t("loading")}</p>
        ) : (
          <>
            <div className="text-muted-foreground flex gap-1 text-[11px]">
              <span>{t("pathLabel")}</span>
              <code className="font-mono break-all">{resolved.packageDir}</code>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {def.prepare && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={anyBusy}
                  onClick={onPrepare}
                  data-testid={`${testId}-prepare`}
                >
                  <HammerIcon className="size-3.5" />
                  {busy === `${entry.ref}:prepare`
                    ? t("prepare.running")
                    : resolved.prepareState === "prepared"
                      ? t("prepare.rerun")
                      : t("prepare.run")}
                </Button>
              )}
              {(["user", "project"] as const).map((scope) => {
                const installed = scope === "user" ? installState?.user : installState?.project
                const unavailable = scope === "project" && installState?.project === null
                return (
                  <div key={scope} className="flex items-center gap-1">
                    <Badge variant="secondary" className="text-[10px]">
                      {t("install.scopeStatus", {
                        scope:
                          scope === "user" ? t("install.scopeUser") : t("install.scopeProject"),
                        status: installed ? t("install.installed") : t("install.notInstalled"),
                      })}
                    </Badge>
                    <Button
                      type="button"
                      variant={installed ? "ghost" : "outline"}
                      size="sm"
                      className="h-7 text-xs"
                      disabled={anyBusy || pi.loading || unavailable}
                      title={unavailable ? t("install.noWorkspace") : undefined}
                      onClick={() => (installed ? onRemove(scope) : onInstall(scope))}
                      data-testid={`${testId}-${installed ? "remove" : "install"}-${scope}`}
                    >
                      {rowBusy &&
                      (busy === `${entry.ref}:install:${scope}` ||
                        busy === `${entry.ref}:remove:${scope}`)
                        ? t("install.working")
                        : installed
                          ? t("install.remove")
                          : t("install.install")}
                    </Button>
                  </div>
                )
              })}
            </div>

            {resolved.hosted ? (
              <div className="space-y-1 text-xs" data-testid={`${testId}-hosted`}>
                <div className="flex items-center gap-1">
                  <PlugZapIcon className="size-3.5" />
                  <span>{t("hosted.available")}</span>
                </div>
                {resolved.tools.length > 0 && (
                  <p className="text-muted-foreground font-mono text-[11px]">
                    {t("hosted.tools", { tools: resolved.tools.join(", ") })}
                  </p>
                )}
                {resolved.controlsSession && (
                  <p
                    className="flex items-start gap-1 text-amber-700 dark:text-amber-400"
                    data-testid={`${testId}-controls-session`}
                  >
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                    {t("hosted.controlsSession")}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground flex items-center gap-1 text-xs">
                <CheckCircle2Icon className="size-3.5" />
                {t("hosted.installOnly")}
              </p>
            )}
          </>
        )}
      </Card>
    </li>
  )
}
