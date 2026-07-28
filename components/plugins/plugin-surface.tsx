"use client"

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from "react"
import { RotateCcwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginSurfaceFormFactor } from "@/types/plugin/plugin-surface"

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" }
const widthHintStyles = new Map<string, CSSProperties>()

function surfaceStyle(
  minWidth: number | undefined,
  maxWidth: number | undefined,
  container: boolean
): CSSProperties {
  if (minWidth === undefined && maxWidth === undefined) {
    return DISPLAY_CONTENTS
  }
  const key = `${minWidth ?? ""}|${maxWidth ?? ""}|${container}`
  const cached = widthHintStyles.get(key)
  if (cached) return cached
  const style: CSSProperties = {
    display: "block",
    minWidth: minWidth === undefined ? undefined : `min(${minWidth}px, 100%)`,
    maxWidth: maxWidth === undefined ? "100%" : `min(${maxWidth}px, 100%)`,
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
      >
        {children}
      </PluginSurfaceBoundary>
    </div>
  )
}
