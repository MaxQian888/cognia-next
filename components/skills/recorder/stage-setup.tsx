"use client"

/**
 * Stage 1 — what to record, and whether this machine can.
 *
 * Three things happen here that are easy to get wrong:
 *
 * - **Scope is a first-class choice, not an advanced option.** "Whole desktop"
 *   is the most capable and the most invasive; showing all three side by side
 *   with what each means is the difference between an informed choice and a
 *   default nobody read.
 * - **A scoped choice needs a target, and the target list is real.** Window and
 *   application scope carry identity fields the native side requires; offering
 *   the radio without the picker made both of them fail to deserialize and
 *   quietly leave "desktop" as the only working option.
 * - **Blockers explain and offer an action.** A preflight that says "permission
 *   denied" and stops has told the user nothing they can use.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  Loader2,
  MonitorSmartphone,
  AppWindow,
  Layers,
  RefreshCw,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { recordListCaptureTargets } from "@/lib/skills/recording/recorder-client"
import {
  blockerCode,
  blockerDetail,
  type CaptureScope,
  type CaptureTarget,
} from "@/lib/skills/recording/types"
import {
  useRecorderError,
  useRecorderOptions,
  useRecorderPhase,
  useRecorderPreflight,
} from "@/hooks/skills/use-skill-recorder"
import { useRecorderStore } from "@/stores/skills/recorder-store"

type ScopeKind = CaptureScope["kind"]

const SCOPE_ICONS = {
  window: AppWindow,
  application: Layers,
  desktop: MonitorSmartphone,
} as const

interface Props {
  scopeKind: ScopeKind
  onScopeKindChange: (kind: ScopeKind) => void
  target: CaptureTarget | null
  onTargetChange: (target: CaptureTarget | null) => void
  onRetryPreflight: () => void
}

export function StageSetup({
  scopeKind,
  onScopeKindChange,
  target,
  onTargetChange,
  onRetryPreflight,
}: Props) {
  const t = useTranslations("skills.recorder")
  const phase = useRecorderPhase()
  const preflight = useRecorderPreflight()
  const error = useRecorderError()
  const options = useRecorderOptions()
  const setOptions = useRecorderStore((state) => state.setOptions)

  /**
   * The enumeration result, stamped with the request it answered.
   *
   * One state object rather than three, and written only from the async
   * callbacks: a synchronous `setLoading(true)` in the effect body is a
   * cascading render, and "loading" is derivable anyway — it is exactly "the
   * newest request has not landed yet".
   */
  const [loaded, setLoaded] = useState<{
    token: number
    targets: CaptureTarget[] | null
    failed: boolean
  }>({ token: -1, targets: null, failed: false })
  const [reloadToken, setReloadToken] = useState(0)

  const needsTarget = scopeKind !== "desktop"
  const targets = loaded.targets
  const targetsError = loaded.failed
  const loadingTargets = needsTarget && loaded.token !== reloadToken

  // Enumerated on demand rather than on mount: the list is a live snapshot of
  // the user's desktop, and one fetched when the Sheet opened would be stale by
  // the time they pick from it.
  useEffect(() => {
    if (!needsTarget || !isTauri()) return
    let cancelled = false
    void recordListCaptureTargets().then(
      (list) => {
        if (cancelled) return
        setLoaded({ token: reloadToken, targets: list, failed: false })
        // Preselect the focused window so the common case is one click, but
        // keep an existing choice if it is still open — re-listing must not
        // silently retarget a recording the user was about to start.
        onTargetChange(
          list.find((candidate) => candidate.windowId === target?.windowId) ??
            list.find((candidate) => candidate.focused) ??
            list[0] ??
            null
        )
      },
      () => {
        if (cancelled) return
        // Fail closed: a null target disables Start, where a silent fallback
        // would have recorded the whole desktop instead.
        setLoaded({ token: reloadToken, targets: [], failed: true })
        onTargetChange(null)
      }
    )
    return () => {
      cancelled = true
    }
    // `target` is read but deliberately not a dependency: including it would
    // re-enumerate on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsTarget, reloadToken, onTargetChange])

  const checking = phase === "preflight"

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label className="text-sm font-medium">{t("setup.scope")}</Label>
        <div className="grid gap-2" role="radiogroup" aria-label={t("setup.scope")}>
          {(["window", "application", "desktop"] as const).map((kind) => {
            const Icon = SCOPE_ICONS[kind]
            const selected = scopeKind === kind
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onScopeKindChange(kind)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  selected ? "border-primary bg-accent/40" : "hover:bg-accent/20"
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="space-y-0.5">
                  <span className="block text-sm">
                    {t(
                      kind === "window"
                        ? "setup.scopeWindow"
                        : kind === "application"
                          ? "setup.scopeApplication"
                          : "setup.scopeDesktop"
                    )}
                  </span>
                  {kind === "desktop" ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("setup.scopeDesktopHint")}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("setup.scopeHint")}</p>
      </section>

      {needsTarget ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm font-medium">
              {t(scopeKind === "window" ? "setup.targetWindow" : "setup.targetApplication")}
            </Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReloadToken((token) => token + 1)}
              disabled={loadingTargets}
            >
              <RefreshCw className={cn("size-3.5", loadingTargets && "animate-spin")} aria-hidden />
              {t("setup.targetRefresh")}
            </Button>
          </div>

          {loadingTargets && targets === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("setup.targetLoading")}
            </p>
          ) : null}

          {targetsError ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <AlertDescription className="text-xs">{t("setup.targetFailed")}</AlertDescription>
            </Alert>
          ) : null}

          {targets && targets.length === 0 && !targetsError ? (
            <p className="text-xs text-muted-foreground">{t("setup.targetEmpty")}</p>
          ) : null}

          {targets && targets.length > 0 ? (
            <div
              className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-1"
              role="radiogroup"
              aria-label={t(
                scopeKind === "window" ? "setup.targetWindow" : "setup.targetApplication"
              )}
            >
              {targets.map((candidate) => {
                const selected = candidate.windowId === target?.windowId
                return (
                  <button
                    key={candidate.windowId}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onTargetChange(candidate)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
                      selected ? "bg-accent" : "hover:bg-accent/40"
                    )}
                  >
                    <span className="text-sm">{candidate.appName}</span>
                    {scopeKind === "window" && candidate.title ? (
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {candidate.title}
                      </span>
                    ) : null}
                    {candidate.minimized ? (
                      <span className="text-xs text-amber-600 dark:text-amber-500">
                        {t("setup.targetMinimized")}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {t(scopeKind === "window" ? "setup.targetWindowHint" : "setup.targetApplicationHint")}
          </p>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="recorder-screenshots" className="text-sm">
              {t("setup.attachScreenshots")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("setup.attachScreenshotsHint")}</p>
          </div>
          <Switch
            id="recorder-screenshots"
            checked={options.captureScreenshots}
            onCheckedChange={(captureScreenshots) => setOptions({ captureScreenshots })}
          />
        </div>
      </section>

      {checking ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("preflight.checking")}
        </p>
      ) : null}

      {preflight && !preflight.ready ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>{t("preflight.blocker.unknown")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <ul className="list-disc space-y-1 pl-4">
              {preflight.blockers.map((blocker) => (
                <li key={blocker}>
                  {t(`preflight.blocker.${blockerCode(blocker)}`, {
                    detail: blockerDetail(blocker) ?? "",
                  })}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" onClick={onRetryPreflight}>
              {t("preflight.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {preflight?.ready && !preflight.ocrAvailable ? (
        <p className="text-xs text-muted-foreground">{t("preflight.ocrUnavailable")}</p>
      ) : null}

      {error && !preflight ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            {t(`preflight.blocker.${blockerCode(error.code)}`, {
              detail: error.detail ?? "",
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("setup.consentNote")}</p>
    </div>
  )
}
