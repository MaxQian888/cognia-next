"use client"

import { Suspense, lazy, useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ArtifactPreview } from "@/components/artifacts/artifact-preview"
import { CodeBlock } from "@/components/chat/renderers/code-block"
import { A2UIWidgetShell } from "@/components/a2ui/a2ui-widget-shell"
import { A2UIComparisonCards } from "./a2ui-comparison-cards"
import { A2UIStepperShell } from "../layout/a2ui-stepper-shell"
import { A2UITable } from "../data/a2ui-table"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logging"
import { getValueByPath, resolveArrayOrPath, resolveStringOrPath } from "@/lib/a2ui/data-model"
import { resolveWidgetMetadata } from "@/lib/a2ui/catalog"
import { routeRichOutputProfile } from "@/lib/a2ui/output-profiles"
import type {
  A2UIComponentProps,
  A2UIRichOutputComponent,
  A2UIRichOutputChartData,
  A2UIRichOutputItem,
  A2UIRichOutputStep,
  A2UIWidgetMetadata,
} from "@/types/a2ui/schema"
import type { Artifact } from "@/types"

const ChartJsRichOutput = lazy(() =>
  import("../rich-output/chartjs-rich-output").then((mod) => ({ default: mod.ChartJsRichOutput }))
)
const CanvasSimulationRichOutput = lazy(() =>
  import("../rich-output/canvas-simulation-rich-output").then((mod) => ({
    default: mod.CanvasSimulationRichOutput,
  }))
)
const ThreeSceneRichOutput = lazy(() =>
  import("../rich-output/three-scene-rich-output").then((mod) => ({
    default: mod.ThreeSceneRichOutput,
  }))
)
const ToneSynthRichOutput = lazy(() =>
  import("../rich-output/tone-synth-rich-output").then((mod) => ({
    default: mod.ToneSynthRichOutput,
  }))
)
const D3ForceGraphRichOutput = lazy(() =>
  import("../rich-output/d3-force-graph-rich-output").then((mod) => ({
    default: mod.D3ForceGraphRichOutput,
  }))
)
const SvgPlotterRichOutput = lazy(() =>
  import("../rich-output/svg-plotter-rich-output").then((mod) => ({
    default: mod.SvgPlotterRichOutput,
  }))
)

function resolveObjectPath<T>(
  value: T | { path: string } | undefined,
  dataModel: Record<string, unknown>,
  defaultValue: T
): T {
  if (!value) {
    return defaultValue
  }

  if (typeof value === "object" && value !== null && "path" in value) {
    const resolved = getValueByPath<T>(dataModel, value.path)
    return resolved ?? defaultValue
  }

  return value as T
}

function getAdvancedProfileFlag(component: A2UIRichOutputComponent): boolean {
  if (typeof component.allowAdvancedProfiles === "boolean") {
    return component.allowAdvancedProfiles
  }

  return process.env.NEXT_PUBLIC_ENABLE_ADVANCED_RICH_OUTPUT_PROFILES !== "false"
}

function createPreviewArtifact(
  component: A2UIRichOutputComponent,
  profileId: string,
  title: string,
  content: string,
  artifactType: Artifact["type"],
  widget: A2UIWidgetMetadata
): Artifact {
  const timestamp = new Date()

  return {
    id: `${component.id}-${profileId}`,
    sessionId: component.id,
    messageId: component.id,
    type: artifactType,
    title,
    content,
    language:
      artifactType === "code"
        ? component.codeLanguage
        : artifactType === "html"
          ? "html"
          : artifactType === "svg"
            ? "svg"
            : artifactType === "mermaid"
              ? "mermaid"
              : undefined,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      outputProfileId: profileId,
      technology: artifactType === "chart" ? "chartjs" : artifactType,
      hostStrategy:
        widget.hostStrategy || (artifactType === "html" ? "sandboxed-html" : "artifact-preview"),
      previewable: artifactType === "html" || artifactType === "svg",
      sandboxed: artifactType === "html",
      widget,
    },
  }
}

export function A2UIRichOutput({
  component,
  dataModel,
  onAction,
  onDataChange,
  surfaceId,
  renderChild,
}: A2UIComponentProps<A2UIRichOutputComponent>) {
  const t = useTranslations("a2ui.richOutput")

  const requestedProfileId = resolveStringOrPath(
    component.profileId,
    dataModel,
    "quick-factual-answer"
  )
  const routedProfile = routeRichOutputProfile(
    requestedProfileId as Parameters<typeof routeRichOutputProfile>[0],
    {
      featureFlags: {
        enableAdvancedRichOutputProfiles: getAdvancedProfileFlag(component),
      },
    }
  )

  const title = resolveStringOrPath(component.title ?? component.profileId, dataModel, "")
  const description = resolveStringOrPath(component.description ?? "", dataModel, "")
  const content = resolveStringOrPath(component.content ?? "", dataModel, "")
  const fallbackContent = resolveStringOrPath(component.fallbackContent ?? "", dataModel, "")
  const items = resolveArrayOrPath(component.items ?? [], dataModel, [])
  const steps = resolveArrayOrPath(component.steps ?? [], dataModel, [])
  const tableRows = resolveArrayOrPath(component.tableRows ?? [], dataModel, [])
  const widgetMetadata = useMemo(
    () => resolveWidgetMetadata({ ...component, profileId: requestedProfileId }),
    [component, requestedProfileId]
  )

  const previewArtifact = useMemo(() => {
    if (!content.trim()) {
      return null
    }

    switch (routedProfile.profile.outputType) {
      case "svg":
        return createPreviewArtifact(
          component,
          routedProfile.profile.id,
          title,
          content,
          "svg",
          widgetMetadata
        )
      case "html":
        return createPreviewArtifact(
          component,
          routedProfile.profile.id,
          title,
          content,
          "html",
          widgetMetadata
        )
      case "mermaid":
        return createPreviewArtifact(
          component,
          routedProfile.profile.id,
          title,
          content,
          "mermaid",
          widgetMetadata
        )
      default:
        return null
    }
  }, [
    component,
    content,
    routedProfile.profile.id,
    routedProfile.profile.outputType,
    title,
    widgetMetadata,
  ])

  const chartData = resolveObjectPath<A2UIRichOutputChartData | null>(
    component.chartData ?? null,
    dataModel,
    null
  )
  const simulationConfig = resolveObjectPath<Record<string, unknown> | null>(
    component.simulationConfig ?? null,
    dataModel,
    null
  )
  const scenePrompt = resolveStringOrPath(component.scenePrompt ?? "", dataModel, "")
  const audioPrompt = resolveStringOrPath(component.audioPrompt ?? "", dataModel, "")
  const networkNodes = resolveArrayOrPath(component.networkNodes ?? [], dataModel, [])
  const networkEdges = resolveArrayOrPath(component.networkEdges ?? [], dataModel, [])
  const plotPoints = resolveArrayOrPath(component.plotPoints ?? [], dataModel, [])

  const fallbackText = fallbackContent || t("richOutputFallback")
  const runtimeFallback = (
    <div className="rounded-lg border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
      Loading rich runtime...
    </div>
  )

  useEffect(() => {
    loggers.ui.info("Rich output profile initialized", {
      componentId: component.id,
      requestedProfileId,
      resolvedProfileId: routedProfile.profile.id,
      hostStrategy: routedProfile.profile.hostStrategy,
      technology: routedProfile.profile.technology,
      usedFallback: routedProfile.usedFallback,
    })
  }, [
    component.id,
    requestedProfileId,
    routedProfile.profile.hostStrategy,
    routedProfile.profile.id,
    routedProfile.profile.technology,
    routedProfile.usedFallback,
  ])

  useEffect(() => {
    if (!routedProfile.usedFallback) {
      return
    }

    loggers.ui.warn("Rich output profile fallback activated", {
      componentId: component.id,
      requestedProfileId,
      resolvedProfileId: routedProfile.profile.id,
      reason: routedProfile.reason,
    })
  }, [
    component.id,
    requestedProfileId,
    routedProfile.profile.id,
    routedProfile.reason,
    routedProfile.usedFallback,
  ])

  const renderNativeContent = () => {
    if (
      (routedProfile.profile.id === "kpis-metrics" ||
        routedProfile.profile.id === "choose-between-options") &&
      items.length > 0
    ) {
      return (
        <A2UIComparisonCards
          component={{
            id: `${component.id}-comparison`,
            component: "ComparisonCards",
            items: items as A2UIRichOutputItem[],
          }}
          surfaceId={surfaceId}
          dataModel={dataModel}
          onAction={onAction}
          onDataChange={onDataChange}
          renderChild={renderChild}
        />
      )
    }

    if (routedProfile.profile.id === "cyclic-process" && steps.length > 0) {
      return (
        <A2UIStepperShell
          component={{
            id: `${component.id}-stepper`,
            component: "StepperShell",
            title,
            description,
            steps: steps as A2UIRichOutputStep[],
            currentStep: component.currentStep,
            currentStepPath: component.currentStepPath,
            stepChangeAction: component.stepChangeAction,
            actionMeta: {
              profileId: routedProfile.profile.id,
            },
            previousLabel: t("previous"),
            nextLabel: t("next"),
          }}
          surfaceId={surfaceId}
          dataModel={dataModel}
          onAction={onAction}
          onDataChange={onDataChange}
          renderChild={renderChild}
        />
      )
    }

    if (
      routedProfile.profile.id === "data-exploration" &&
      component.tableColumns &&
      component.tableColumns.length > 0 &&
      tableRows.length > 0
    ) {
      return (
        <A2UITable
          component={{
            id: `${component.id}-explorer`,
            component: "Table",
            columns: component.tableColumns.map((column) => ({
              ...column,
              header: column.label,
              sortable: true,
            })),
            data: tableRows as Record<string, unknown>[],
            sortKeyPath: component.sortKeyPath,
            sortDirectionPath: component.sortDirectionPath,
            sortAction: component.sortAction,
            actionMeta: {
              profileId: routedProfile.profile.id,
            },
          }}
          surfaceId={surfaceId}
          dataModel={dataModel}
          onAction={onAction}
          onDataChange={onDataChange}
          renderChild={renderChild}
        />
      )
    }

    if (routedProfile.profile.outputType === "code") {
      return <CodeBlock code={content} language={component.codeLanguage} />
    }

    return (
      <div
        className={cn(
          "rounded-lg border border-border/60 bg-background/70 px-4 py-3 text-sm leading-6",
          routedProfile.profile.outputType === "warm-text" &&
            "bg-amber-50/70 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
        )}
      >
        {content || fallbackText}
      </div>
    )
  }

  const renderBody = () => {
    if (
      ((routedProfile.profile.id === "kpis-metrics" ||
        routedProfile.profile.id === "choose-between-options") &&
        items.length > 0) ||
      (routedProfile.profile.id === "cyclic-process" && steps.length > 0) ||
      (routedProfile.profile.id === "data-exploration" &&
        component.tableColumns &&
        component.tableColumns.length > 0 &&
        tableRows.length > 0) ||
      routedProfile.profile.outputType === "plain-text" ||
      routedProfile.profile.outputType === "warm-text" ||
      routedProfile.profile.outputType === "code"
    ) {
      return renderNativeContent()
    }

    if (routedProfile.usedFallback && fallbackContent.trim()) {
      return (
        <div className="rounded-lg border border-border/60 bg-background/70 px-4 py-3 text-sm leading-6">
          {fallbackText}
        </div>
      )
    }

    if (
      routedProfile.profile.technology === "chartjs" &&
      chartData &&
      (routedProfile.profile.id === "trends-over-time" ||
        routedProfile.profile.id === "category-comparison" ||
        routedProfile.profile.id === "part-of-whole")
    ) {
      const chartType =
        routedProfile.profile.id === "trends-over-time"
          ? "line"
          : routedProfile.profile.id === "part-of-whole"
            ? "doughnut"
            : "bar"

      return (
        <Suspense fallback={runtimeFallback}>
          <ChartJsRichOutput chartType={chartType} data={chartData} height={component.height} />
        </Suspense>
      )
    }

    if (routedProfile.profile.id === "physics-math-simulation" && simulationConfig) {
      return (
        <Suspense fallback={runtimeFallback}>
          <CanvasSimulationRichOutput config={simulationConfig} height={component.height} />
        </Suspense>
      )
    }

    if (routedProfile.profile.id === "3d-visualization") {
      return (
        <Suspense fallback={runtimeFallback}>
          <ThreeSceneRichOutput prompt={scenePrompt} height={component.height} />
        </Suspense>
      )
    }

    if (routedProfile.profile.id === "music-audio") {
      return (
        <Suspense fallback={runtimeFallback}>
          <ToneSynthRichOutput prompt={audioPrompt} />
        </Suspense>
      )
    }

    if (
      routedProfile.profile.id === "network-graph" &&
      networkNodes.length > 0 &&
      networkEdges.length > 0
    ) {
      return (
        <Suspense fallback={runtimeFallback}>
          <D3ForceGraphRichOutput
            nodes={networkNodes}
            edges={networkEdges}
            height={component.height}
          />
        </Suspense>
      )
    }

    if (routedProfile.profile.id === "function-equation-plotter" && plotPoints.length > 0) {
      return (
        <Suspense fallback={runtimeFallback}>
          <SvgPlotterRichOutput points={plotPoints} height={component.height} />
        </Suspense>
      )
    }

    if (previewArtifact) {
      return <ArtifactPreview artifact={previewArtifact} className="min-h-[220px]" />
    }

    if (routedProfile.profile.rolloutTier === "advanced") {
      loggers.ui.warn("Rich output advanced adapter unavailable, using fallback text", {
        componentId: component.id,
        requestedProfileId,
        resolvedProfileId: routedProfile.profile.id,
      })

      return (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{fallbackText || t("richOutputUnavailable")}</AlertDescription>
        </Alert>
      )
    }
    return renderNativeContent()
  }

  return (
    <A2UIWidgetShell
      title={title}
      description={description}
      hostStrategy={widgetMetadata.hostStrategy}
      status={routedProfile.usedFallback ? "fallback" : widgetMetadata.status}
      statusLabel={routedProfile.usedFallback ? t("richOutputFallback") : undefined}
      fallbackText={fallbackText}
      showChrome={widgetMetadata.showChrome}
      className={component.className}
    >
      {renderBody()}
    </A2UIWidgetShell>
  )
}
