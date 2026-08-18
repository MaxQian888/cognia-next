"use client"

// The Agent Packages section of /plugins (ADR-0119).
//
// Pi is the one external backend where Cognia's runtime integration is deep but
// its *configuration* surface was empty — and Pi's package system was untouched
// by any code in this repo. This pane is that surface: what is installed, what
// it costs on every turn, what collides with what, and the reviewed catalog to
// install from.
//
// Two structural decisions worth keeping:
//
//   - **Scopes never merge in the data layer.** The user and project lists are
//     read separately and combined by Pi's own rule (`resolvePiPackages`), so a
//     repo declaring one package cannot make the user's other 17 look gone.
//   - **The CLI is preferred, the fallback is labelled.** `pi install` also
//     downloads; editing `settings.json` only records intent. The dialog says so
//     rather than presenting the two as equivalent.

import { useCallback, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, PackageIcon, RefreshCwIcon, TerminalIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePiPackages } from "@/hooks/plugins"
import type { PiCatalogEntry, PiStackPresetId } from "@/lib/pi-packages/catalog"
import { piConfigPath } from "@/lib/pi-packages/config-templates"
import { PI_INSTALL_PARAM, readPiInstallParam } from "@/lib/pi-packages/deep-link"
import { planPiMutation, type PiMutationPlan } from "@/lib/pi-packages/mutate"
import type { PiPackageScope } from "@/lib/pi-packages/types"
import { PiCatalogList } from "./pi-catalog-list"
import { PiContextBudget, piPackageShortName } from "./pi-context-budget"
import { PiInstallDialog, type PiInstallRequest } from "./pi-install-dialog"
import { PiInstalledList } from "./pi-installed-list"
import { PiOverlapGraph } from "./pi-overlap-graph"
import { PiPackageConfigEditor } from "./pi-package-config-editor"

export function AgentPackagesPane() {
  const t = useTranslations("plugins.agentPackages")
  const pi = usePiPackages()

  const [manualPending, setManualPending] = useState<PiInstallRequest | null>(null)
  const [dismissedSpec, setDismissedSpec] = useState<string | null>(null)
  const [busySpec, setBusySpec] = useState<string | null>(null)
  const [applyingPreset, setApplyingPreset] = useState<PiStackPresetId | null>(null)
  const [configSpec, setConfigSpec] = useState<string | null>(null)

  // ⌘K's `install` action and the external-agent settings entry both land here
  // with `?piInstall=<spec>`. The deep link *chooses* a package; it never
  // installs one — what it opens is the same pre-install gate as any other
  // route in.
  //
  // The staged request is derived from the URL rather than copied into state by
  // an effect: a synchronous `setState` inside an effect causes a cascading
  // render, and this is the case that makes the derivation easy anyway.
  // `dismissedSpec` covers the frame between closing the dialog and the URL
  // actually losing the param, so it cannot flicker back open.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const requestedInstall = readPiInstallParam(searchParams)

  // Memoized because the URL branch builds a fresh object every render, which
  // would otherwise invalidate every downstream memo and callback on each one.
  const pending: PiInstallRequest | null = useMemo(
    () =>
      manualPending ??
      (requestedInstall && requestedInstall !== dismissedSpec
        ? { spec: requestedInstall, scope: "user" as const }
        : null),
    [manualPending, requestedInstall, dismissedSpec]
  )

  /** Close the gate and strip the param, so a reload does not reopen it. */
  const closePending = useCallback(() => {
    setManualPending(null)
    if (!requestedInstall) return
    setDismissedSpec(requestedInstall)
    const next = new URLSearchParams(searchParams?.toString() ?? "")
    next.delete(PI_INSTALL_PARAM)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [requestedInstall, searchParams, router, pathname])

  const installedSpecs = useMemo(() => pi.resolved.map((entry) => entry.pkg), [pi.resolved])

  const plan: PiMutationPlan | null = useMemo(() => {
    if (!pending) return null
    return planPiMutation(
      { kind: "install", spec: pending.spec, scope: pending.scope },
      pi.snapshot?.cli ?? { available: false }
    )
  }, [pending, pi.snapshot?.cli])

  const confirmInstall = useCallback(async () => {
    if (!pending) return
    setBusySpec(pending.spec)
    const name = piPackageShortName(pending.spec)
    try {
      const outcome = await pi.mutate({
        kind: "install",
        spec: pending.spec,
        scope: pending.scope,
      })
      if (outcome.ok) toast.success(t("install.successToast", { name }))
      else toast.error(t("install.failureToast", { name, message: outcome.error ?? "" }))
    } finally {
      setBusySpec(null)
      closePending()
    }
  }, [pending, pi, t, closePending])

  const remove = useCallback(
    async (spec: string, scope: PiPackageScope) => {
      setBusySpec(spec)
      const name = piPackageShortName(spec)
      try {
        const outcome = await pi.mutate({ kind: "remove", spec, scope })
        if (outcome.ok) toast.success(t("install.removeSuccessToast", { name }))
        else toast.error(t("install.removeFailureToast", { name, message: outcome.error ?? "" }))
      } finally {
        setBusySpec(null)
      }
    },
    [pi, t]
  )

  const toggle = useCallback(
    async (spec: string, scope: PiPackageScope, enabled: boolean) => {
      setBusySpec(spec)
      try {
        const result = await pi.setEnabled(spec, scope, enabled)
        if (!result.ok) toast.error(result.error ?? "")
      } finally {
        setBusySpec(null)
      }
    },
    [pi]
  )

  /**
   * Applying a preset installs sequentially, not in parallel: each `pi install`
   * rewrites the same `settings.json`, so concurrent runs would race and lose
   * entries. A partial result is reported as partial rather than as success.
   */
  const applyPreset = useCallback(
    async (preset: PiStackPresetId, missing: PiCatalogEntry[]) => {
      setApplyingPreset(preset)
      let ok = 0
      try {
        for (const entry of missing) {
          const outcome = await pi.mutate({
            kind: "install",
            spec: entry.spec,
            scope: "user",
          })
          if (outcome.ok) ok += 1
        }
      } finally {
        setApplyingPreset(null)
      }
      if (ok === missing.length) toast.success(t("presets.appliedToast", { count: ok }))
      else
        toast.error(
          t("presets.partialToast", {
            ok,
            total: missing.length,
            failed: missing.length - ok,
          })
        )
    },
    [pi, t]
  )

  // Read through a local first: an optional-chained expression inside the memo
  // body makes the React Compiler infer `pi.snapshot.userBaseDir` while the
  // declared dep is `pi.snapshot?.userBaseDir`, and it then refuses to preserve
  // the memo at all (react-hooks/preserve-manual-memoization).
  const userBaseDir = pi.snapshot?.userBaseDir ?? null
  const configPath = useMemo(
    () => (configSpec && userBaseDir ? piConfigPath(userBaseDir, configSpec) : null),
    [configSpec, userBaseDir]
  )

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4" data-testid="agent-packages-pane">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <PackageIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t("title")}</h2>
              <p className="text-muted-foreground text-xs">{t("description")}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void pi.reload()}
            disabled={pi.loading}
          >
            <RefreshCwIcon className="size-3.5" />
            {t("actions.reload")}
          </Button>
        </div>

        {pi.snapshot?.cli.available ? (
          <Badge variant="outline" className="gap-1 font-mono text-[11px]">
            <TerminalIcon className="size-3" />
            {t("cli.detected", { version: pi.snapshot.cli.version ?? "" })}
          </Badge>
        ) : (
          !pi.loading && (
            <Alert data-testid="pi-cli-missing">
              <TerminalIcon className="size-4" />
              <AlertDescription>
                <span className="font-medium">{t("cli.missingTitle")}</span> {t("cli.missingBody")}
              </AlertDescription>
            </Alert>
          )
        )}

        {pi.loading && <p className="text-muted-foreground text-xs">{t("loading")}</p>}

        {!pi.loading && pi.piMissing && (
          <Alert data-testid="pi-missing">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription>
              <span className="font-medium">{t("piMissing.title")}</span> {t("piMissing.body")}{" "}
              <span className="text-muted-foreground">{t("piMissing.hint")}</span>
            </AlertDescription>
          </Alert>
        )}

        {pi.warnings.length > 0 && (
          <Alert data-testid="pi-warnings">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription>
              <span className="font-medium">{t("warnings.title")}</span>
              <ul className="mt-1 space-y-0.5 text-xs">
                {pi.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {pi.discouraged.length > 0 && (
          <Alert variant="destructive" data-testid="pi-discouraged">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription>
              <span className="font-medium">
                {t("discouraged.title", { count: pi.discouraged.length })}
              </span>
              <ul className="mt-1 space-y-0.5 text-xs">
                {pi.discouraged.map((entry) => (
                  <li key={entry.id} className="font-mono">
                    {piPackageShortName(entry.spec)}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {!pi.snapshot?.projectCwd && !pi.loading && (
          <p className="text-muted-foreground text-xs">{t("scope.noWorkspace")}</p>
        )}

        {!pi.loading && (
          <>
            <PiContextBudget budget={pi.budget} />
            <PiOverlapGraph conflicts={pi.overlaps} />
            <PiInstalledList
              resolved={pi.resolved}
              busySpec={busySpec}
              onToggle={(spec, scope, enabled) => void toggle(spec, scope, enabled)}
              onRemove={(spec, scope) => void remove(spec, scope)}
              onConfigure={setConfigSpec}
            />
            <PiCatalogList
              resolved={pi.resolved}
              busySpec={busySpec}
              applyingPreset={applyingPreset}
              onInstall={(spec) => setManualPending({ spec, scope: "user" })}
              onApplyPreset={(preset, missing) => void applyPreset(preset, missing)}
            />
          </>
        )}

        {!pi.loading && pi.resolved.length === 0 && pi.snapshot === null && (
          <Card className="p-4">
            <p className="text-muted-foreground text-xs">{t("desktopOnly")}</p>
          </Card>
        )}

        <PiInstallDialog
          request={pending}
          installed={installedSpecs}
          plan={plan}
          projectPath={pi.projectPath}
          busy={busySpec !== null}
          onConfirm={() => void confirmInstall()}
          onCancel={closePending}
        />

        <PiPackageConfigEditor
          spec={configSpec}
          path={configPath}
          onClose={() => setConfigSpec(null)}
        />
      </div>
    </ScrollArea>
  )
}
