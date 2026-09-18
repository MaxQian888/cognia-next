"use client"

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react"
import { RotateCcwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginSurfaceFormFactor } from "@/types/plugin/plugin-surface"

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" }
/**
 * No width hint declared, but the surface is still a query container.
 *
 * `display: contents` generates no principal box, and `container-type` is inert
 * without one — so returning DISPLAY_CONTENTS here would silently stop every
 * `@container` rule a plugin ships from ever matching, which is the opposite of
 * what `plugin-dev/surfaces.mdx` promises ("Slot wrappers are query
 * containers"). Hosts that genuinely need the host layout preserved say so with
 * `container={false}`.
 */
const QUERY_CONTAINER_ONLY: CSSProperties = {
  display: "block",
  containerType: "inline-size",
  // A `container-type` element's contents cannot size it, so in a flex row
  // this box has no width source and collapses to 0 — while its children
  // keep painting their intrinsic width over whatever the host renders next.
  // The declared box bounds the paint instead of letting it bleed.
  overflow: "hidden",
}
const widthHintStyles = new Map<string, CSSProperties>()

function surfaceStyle(
  minWidth: number | undefined,
  maxWidth: number | undefined,
  container: boolean
): CSSProperties {
  if (minWidth === undefined && maxWidth === undefined) {
    return container ? QUERY_CONTAINER_ONLY : DISPLAY_CONTENTS
  }
  const key = `${minWidth ?? ""}|${maxWidth ?? ""}|${container}`
  const cached = widthHintStyles.get(key)
  if (cached) return cached
  const style: CSSProperties = {
    display: "block",
    // The same containment collapse makes `min-width`/`max-width` alone
    // toothless in a flex row (their percentage fallbacks resolve to 0, and
    // content never feeds `flex-basis: auto`), so the row granted the
    // surface 0px and the plugin painted past it. `flex-basis` is the one
    // width source the row can honour unconditionally: grant the declared
    // floor — the width the plugin said it needs — and let `flex-shrink`
    // squeeze below it when the host genuinely runs out. A block host
    // ignores the basis and stretches within the same min/max bounds.
    flexBasis: `${minWidth ?? maxWidth}px`,
    minWidth: minWidth === undefined ? undefined : `min(${minWidth}px, 100%)`,
    maxWidth: maxWidth === undefined ? "100%" : `min(${maxWidth}px, 100%)`,
    // Under that squeeze the surface ends up narrower than its content;
    // clip rather than bleed. `container={false}` keeps `overflow: visible`
    // — it exists for panels whose positioned descendants must escape.
    overflow: container ? "hidden" : undefined,
    containerType: container ? "inline-size" : undefined,
  }
  widthHintStyles.set(key, style)
  return style
}

export interface PluginSurfaceProps {
  pluginId: string
  pluginName?: string
  surfaceId: string
  formFactor: PluginSurfaceFormFactor
  minWidth?: number
  maxWidth?: number
  /**
   * Iframes have their own document and cannot consume the host stylesheet's
   * `@scope`, but still share crash reporting and fallback behavior.
   */
  variant?: "default" | "iframe"
  /**
   * Context Workbench panels opt out because CSS containment re-anchors
   * absolutely positioned descendants.
   */
  container?: boolean
  /**
   * Notified when the compact boundary removes a crashed child — the signal a
   * slot needs to count the contribution as absent (and fall back) rather than
   * keep a dead declared-width box.
   */
  onSilentFailure?: () => void
  className?: string
  children: ReactNode
}

interface BoundaryProps {
  pluginId: string
  pluginName: string
  surfaceId: string
  formFactor: PluginSurfaceFormFactor
  diagnosticMessage: (errorMessage: string) => string
  compactDiagnosticHint: string
  retryDiagnosticHint: string
  /**
   * Fires only when the boundary swallows the crash — the compact form factors
   * that render `null`. Panel/block surfaces keep a visible diagnostic card
   * with retry, so the contribution is still present and this stays silent.
   */
  onSilentFailure?: () => void
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

function PluginSurfaceError({
  pluginName,
  error,
  retry,
}: {
  pluginName: string
  error: Error
  retry: () => void
}) {
  const t = useTranslations("plugins.surface")
  return (
    <div
      role="alert"
      data-plugin-surface-error
      className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-center"
    >
      <p className="text-sm font-medium">{t("title", { pluginName })}</p>
      <p className="max-w-full break-words text-xs text-muted-foreground">
        {t("description", { error: error.message })}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={retry}>
        <RotateCcwIcon className="size-4" />
        {t("retry")}
      </Button>
    </div>
  )
}

export class PluginSurfaceBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const errorMessage = error instanceof Error ? error.message : String(error)
    // The localStorage analytics store below has never had a reader. The
    // Dexie counter the Governance view actually reads had no writer, so the
    // same error was recorded in the one place nothing looks at and not in the
    // one place something does.
    void import("@/lib/plugin/analytics/record").then(
      ({ recordPluginAnalytic, PLUGIN_ANALYTIC_KEYS }) => {
        void recordPluginAnalytic(this.props.pluginId, PLUGIN_ANALYTIC_KEYS.surfaceError)
      }
    )
    void import("@/lib/plugin/utils/analytics").then(({ trackPluginEvent }) => {
      trackPluginEvent?.({
        pluginId: this.props.pluginId,
        eventType: "error",
        success: false,
        errorMessage,
        metadata: {
          surfaceId: this.props.surfaceId,
          formFactor: this.props.formFactor,
          scope: "surface.render_error",
        },
      })
    })
    void import("@/lib/plugin/contracts/diagnostics-store").then(
      ({ recordPluginPointDiagnostic }) => {
        recordPluginPointDiagnostic(this.props.pluginId, {
          code: "plugin.silent-failure",
          severity: "error",
          pointKind: "runtime",
          pointId: this.props.surfaceId,
          message: this.props.diagnosticMessage(errorMessage),
          hint:
            this.props.formFactor === "icon" || this.props.formFactor === "row"
              ? this.props.compactDiagnosticHint
              : this.props.retryDiagnosticHint,
        })
      }
    )
    if (this.props.formFactor === "icon" || this.props.formFactor === "row") {
      this.props.onSilentFailure?.()
    }
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.formFactor === "icon" || this.props.formFactor === "row") return null
    return (
      <PluginSurfaceError pluginName={this.props.pluginName} error={error} retry={this.retry} />
    )
  }
}

export function PluginSurface({
  pluginId,
  pluginName,
  surfaceId,
  formFactor,
  minWidth,
  maxWidth,
  variant = "default",
  container = true,
  onSilentFailure,
  className,
  children,
}: PluginSurfaceProps) {
  const diagnosticT = useTranslations("plugins.surface.diagnostic")
  const manifestName = usePluginStore((state) => state.plugins[pluginId]?.manifest.name)
  const resolvedPluginName = pluginName ?? manifestName ?? pluginId
  return (
    <div
      className={className}
      data-plugin-root={variant === "default" ? pluginId : undefined}
      data-plugin-surface={surfaceId}
      data-plugin-form-factor={formFactor}
      style={surfaceStyle(minWidth, maxWidth, container)}
    >
      <PluginSurfaceBoundary
        pluginId={pluginId}
        pluginName={resolvedPluginName}
        surfaceId={surfaceId}
        formFactor={formFactor}
        diagnosticMessage={(errorMessage) =>
          diagnosticT("message", { surfaceId, error: errorMessage })
        }
        compactDiagnosticHint={diagnosticT("compactHint")}
        retryDiagnosticHint={diagnosticT("retryHint")}
        onSilentFailure={onSilentFailure}
      >
        {children}
      </PluginSurfaceBoundary>
    </div>
  )
}
