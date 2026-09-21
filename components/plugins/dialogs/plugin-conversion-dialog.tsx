"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PluginConversionReport } from "../_shared/plugin-conversion-report"
import {
  getPluginConversionService,
  type InspectPluginConversionResult,
} from "@/lib/plugin/convert/agent-service"
import {
  PLUGIN_ECOSYSTEMS,
  type PluginDeliveryTarget,
  type PluginDeliverySurface,
} from "@/lib/plugin/convert/delivery"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

export interface PluginConversionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Each opening owns its review plan; closing discards pending inspection results. */
export function PluginConversionDialog(props: PluginConversionDialogProps) {
  return props.open ? <ConversionSession onOpenChange={props.onOpenChange} /> : null
}

function ConversionSession({ onOpenChange }: Pick<PluginConversionDialogProps, "onOpenChange">) {
  const t = useTranslations("plugins.conversionDialog")
  const tReport = useTranslations("plugins.conversionReport")
  const project = useProjectStore((state) =>
    state.projects.find((entry) => entry.id === state.activeProjectId)
  )
  const [workspaceRoot, setWorkspaceRoot] = useState(() =>
    project ? (primaryRootOf(project)?.path ?? "") : ""
  )
  const [sourceDir, setSourceDir] = useState("")
  const [target, setTarget] = useState<PluginDeliveryTarget>("cognia")
  const [surface, setSurface] = useState<PluginDeliverySurface>("cli")
  const [inspection, setInspection] = useState<InspectPluginConversionResult | null>(null)
  const [outputDir, setOutputDir] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [phase, setPhase] = useState<"idle" | "inspecting" | "applying">("idle")
  const [error, setError] = useState<string | null>(null)
  const [writtenPath, setWrittenPath] = useState<string | null>(null)
  const alive = useRef(true)
  const revision = useRef(0)
  const applying = useRef(false)
  const id = useId()
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      revision.current += 1
    }
  }, [])

  const invalidate = () => {
    revision.current += 1
    setInspection(null)
    setAcknowledged(false)
    setWrittenPath(null)
    setError(null)
    setPhase("idle")
  }
  const inspect = async () => {
    if (applying.current || phase === "inspecting") return
    invalidate()
    const token = revision.current
    setPhase("inspecting")
    try {
      const result = await getPluginConversionService().inspect({
        workspaceRoot: workspaceRoot.trim(),
        sourceDir: sourceDir.trim(),
        target,
        surface,
      })
      if (!alive.current || revision.current !== token) return
      setInspection(result)
      setOutputDir(result.proposedOutputDir)
    } catch (cause) {
      if (alive.current && revision.current === token)
        setError(
          t("inspectFailed", { message: cause instanceof Error ? cause.message : String(cause) })
        )
    } finally {
      if (alive.current && revision.current === token) setPhase("idle")
    }
  }
  const requiresAcknowledgement = Boolean(
    inspection &&
    (inspection.report.warnings.length > 0 || inspection.report.fidelity === "contextual")
  )
  const canApply = Boolean(
    inspection?.applicable &&
    inspection.planId &&
    inspection.report.blocking.length === 0 &&
    outputDir.trim() &&
    (!requiresAcknowledgement || acknowledged) &&
    !writtenPath
  )
  const apply = async () => {
    if (!canApply || !inspection?.planId || applying.current) return
    applying.current = true
    setPhase("applying")
    setError(null)
    const token = revision.current
    try {
      const result = await getPluginConversionService().apply({
        workspaceRoot: workspaceRoot.trim(),
        planId: inspection.planId,
        outputDir: outputDir.trim(),
        acknowledgeWarnings: acknowledged,
      })
      if (alive.current && revision.current === token) setWrittenPath(result.outputDir)
    } catch (cause) {
      if (alive.current && revision.current === token)
        setError(
          t("writeFailed", { message: cause instanceof Error ? cause.message : String(cause) })
        )
    } finally {
      applying.current = false
      if (alive.current && revision.current === token) setPhase("idle")
    }
  }
  const close = () => {
    if (!applying.current) onOpenChange(false)
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 pr-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-root`}>{t("workspaceRoot")}</Label>
              <Input
                id={`${id}-root`}
                value={workspaceRoot}
                disabled={phase === "applying"}
                onChange={(event) => {
                  invalidate()
                  setWorkspaceRoot(event.target.value)
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-source`}>{t("sourceDir")}</Label>
              <Input
                id={`${id}-source`}
                value={sourceDir}
                disabled={phase === "applying"}
                onChange={(event) => {
                  invalidate()
                  setSourceDir(event.target.value)
                }}
              />
              <p className="text-xs text-muted-foreground">{t("relativePaths")}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-target`}>{t("target")}</Label>
                <NativeSelect
                  id={`${id}-target`}
                  value={target}
                  disabled={phase === "applying"}
                  wrapperClassName="w-full"
                  onChange={(event) => {
                    invalidate()
                    setTarget(event.target.value as PluginDeliveryTarget)
                  }}
                >
                  {PLUGIN_ECOSYSTEMS.map((entry) => (
                    <NativeSelectOption key={entry} value={entry}>
                      {tReport(`sources.${entry}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-surface`}>{t("surface")}</Label>
                <NativeSelect
                  id={`${id}-surface`}
                  value={surface}
                  disabled={phase === "applying"}
                  wrapperClassName="w-full"
                  onChange={(event) => {
                    invalidate()
                    setSurface(event.target.value as PluginDeliverySurface)
                  }}
                >
                  {(["cli", "desktop", "cloud"] as const).map((entry) => (
                    <NativeSelectOption key={entry} value={entry}>
                      {t(`surfaces.${entry}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            {surface === "cloud" && (
              <p className="text-xs text-muted-foreground">{t("cloudHint")}</p>
            )}
            {inspection && (
              <>
                <PluginConversionReport
                  sourceFormat={inspection.sourceFormat}
                  report={inspection.report}
                  maxIssues={false}
                />
                <details open>
                  <summary className="text-sm font-medium">
                    {t("files", { count: inspection.files.length })}
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs font-mono">
                    {inspection.files.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </details>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-output`}>{t("outputDir")}</Label>
                  <Input
                    id={`${id}-output`}
                    value={outputDir}
                    disabled={phase === "applying" || Boolean(writtenPath)}
                    onChange={(event) => {
                      setOutputDir(event.target.value)
                      setError(null)
                    }}
                  />
                </div>
                {requiresAcknowledgement && (
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={`${id}-ack`}
                      checked={acknowledged}
                      disabled={phase === "applying" || Boolean(writtenPath)}
                      onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    />
                    <Label htmlFor={`${id}-ack`} className="text-sm leading-5">
                      {t("acknowledge")}
                    </Label>
                  </div>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {writtenPath && (
              <p role="status" className="text-sm break-all">
                {t("written", { path: writtenPath })}
              </p>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" disabled={phase === "applying"} onClick={close}>
            {t("close")}
          </Button>
          <Button
            variant="outline"
            disabled={phase !== "idle" || !workspaceRoot.trim() || !sourceDir.trim()}
            onClick={() => void inspect()}
          >
            {t(phase === "inspecting" ? "inspecting" : "inspect")}
          </Button>
          <Button disabled={!canApply || phase !== "idle"} onClick={() => void apply()}>
            {t(phase === "applying" ? "writing" : "write")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
