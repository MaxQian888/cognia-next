// Per-model Live2D customization dialog: a Transform tab (scale/offset with a
// live re-fit) and a Motion-mapping tab (state → motion/expression overrides
// with per-row Test buttons), above a live preview canvas. The dialog owns a
// DRAFT (transform + overrides) so edits preview immediately but persist only
// on Save through `updatePetModelCustomization`; the production pet picks the
// saved values up via the reactive model row.

"use client"

import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  getPetModelEntries,
  updatePetModelCustomization,
  type PetModelRow,
} from "@/lib/db/pet-models"
import { extractMotionGroupCounts } from "@/lib/pet/live2d/manifest"
import { readBlobText } from "@/lib/pet/live2d/read-blob-text"
import { STATE_KEYS, type MappingRow } from "@/lib/pet/live2d/state-keys"
import { normalizeTransform } from "@/lib/pet/live2d/transform"
import { getPetSkinRuntime, type PetRuntimeLease } from "@/lib/pet/skin-runtime"
import { generateBones } from "@/lib/pet/bones/generate"
import { useCubismCoreAvailable } from "@/hooks/pet/use-active-live2d-model"
import {
  DEFAULT_LIVE2D_TRANSFORM,
  type Live2dMotionOverrides,
  type Live2dParameterMapping,
  type Live2dParameterRole,
  type Live2dTransform,
  type PetOneShot,
  type PetVisualState,
} from "@/types/pet"
import { PetModelMotionEditor } from "./pet-model-motion-editor"
import { PetModelTransformEditor } from "./pet-model-transform-editor"

const Live2dCanvas = lazy(() => import("@/components/pet/skins/live2d/live2d-canvas"))

/** Deterministic bones for the preview — the canvas renders the Live2D model,
 * so only the prop SHAPE matters, but keep it honest with a real generation. */
const PREVIEW_BONES = generateBones("pet-model-config-preview")

const PREVIEW_SIZE = 220

/** How long a tested one-shot stays active before clearing back to resting. */
const TEST_SHOT_MS = 1500
const PARAMETER_ROLES: Live2dParameterRole[] = [
  "headX",
  "headY",
  "headZ",
  "eyeX",
  "eyeY",
  "bodyX",
  "bodyY",
  "mouthOpen",
]

export interface PetModelConfigDialogProps {
  /**
   * The model being edited. The draft seeds from this row at MOUNT — callers
   * must remount per editing session (the manager keys the dialog by model id
   * and unmounts it on close), which keeps the draft logic effect-free.
   */
  model: PetModelRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PetModelConfigDialog({ model, open, onOpenChange }: PetModelConfigDialogProps) {
  const t = useTranslations("settings.pet.live2d.config")
  const tStates = useTranslations("settings.pet.live2d.stateLabels")
  const tErr = useTranslations("settings.pet.live2d.errors")
  const coreReady = useCubismCoreAvailable()

  const [transform, setTransform] = useState<Live2dTransform>(() =>
    normalizeTransform(model.transform)
  )
  const [overrides, setOverrides] = useState<Live2dMotionOverrides>(
    () => model.motionOverrides ?? {}
  )
  const [parameterMapping, setParameterMapping] = useState<Live2dParameterMapping>(
    () => model.parameterMapping ?? {}
  )
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [previewState, setPreviewState] = useState<PetVisualState>("idle")
  const [previewShot, setPreviewShot] = useState<PetOneShot | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const shotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runtime = getPetSkinRuntime()
  const leaseOwner = useId()
  const [lease, setLease] = useState<PetRuntimeLease | null>(null)
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  useEffect(() => {
    if (!open) return
    const next = runtime.acquireLease(leaseOwner, "configuration", `live2d:${model.id}`)
    let active = true
    queueMicrotask(() => {
      if (active) setLease(next)
    })
    return () => {
      active = false
      next.release()
    }
  }, [leaseOwner, model.id, open, runtime])

  // A model that fails to load reports a typed code through the canvas's
  // `onError`; surface it instead of leaving an empty preview surface. Clear it
  // the render the dialog (re)opens so a fixed/replaced model gets a fresh
  // attempt — React's "adjust state during render" pattern (no effect cascade).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setPreviewError(null)
  }

  // Motion counts per group (sizes the index dropdowns + powers random play).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const entries = await getPetModelEntries(model.id)
        const settings = entries.find((e) => e.path === model.settingsPath)
        if (!settings) return
        const next = extractMotionGroupCounts(await readBlobText(settings.blob))
        if (!cancelled) setCounts(next)
      } catch {
        // Best-effort — index dropdowns just offer "random" without counts.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, model.id, model.settingsPath])

  useEffect(() => {
    return () => {
      if (shotTimerRef.current) clearTimeout(shotTimerRef.current)
    }
  }, [])

  // Play a row in the preview. One-shots are edge-triggered in the motion
  // hook, so pulse null → shot → null; states simply switch the resting state.
  const handleTest = (row: MappingRow) => {
    if (shotTimerRef.current) clearTimeout(shotTimerRef.current)
    if (row.kind === "oneShot") {
      setPreviewShot(null)
      shotTimerRef.current = setTimeout(() => {
        setPreviewShot(row.id as PetOneShot)
        shotTimerRef.current = setTimeout(() => setPreviewShot(null), TEST_SHOT_MS)
      }, 0)
    } else {
      setPreviewShot(null)
      setPreviewState(row.id as PetVisualState)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await updatePetModelCustomization(model.id, {
        transform: normalizeTransform(transform),
        motionOverrides: overrides,
        parameterMapping,
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const handleResetAll = () => {
    setTransform({ ...DEFAULT_LIVE2D_TRANSFORM })
    setOverrides({})
    setParameterMapping({})
  }

  const setParameterRoleMode = (
    role: Live2dParameterRole,
    mode: "auto" | "custom" | "disabled"
  ) => {
    setParameterMapping((current) => {
      const next = { ...current }
      if (mode === "auto") delete next[role]
      else next[role] = mode === "disabled" ? null : ""
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title", { name: model.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {coreReady ? (
          <div className="flex flex-col items-center gap-2">
            {previewError ? (
              <div
                role="alert"
                className="flex items-center justify-center text-center text-sm text-destructive"
                style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
              >
                {tErr(previewError)}
              </div>
            ) : lease?.mode() === "live" ? (
              <Suspense fallback={<div style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }} />}>
                <Live2dCanvas
                  modelId={model.id}
                  bones={PREVIEW_BONES}
                  stage="adult"
                  state={previewState}
                  oneShot={previewShot}
                  reducedMotion={false}
                  size={PREVIEW_SIZE}
                  transform={normalizeTransform(transform)}
                  motionOverrides={overrides}
                  parameterMappingOverrides={parameterMapping}
                  selection={{ skinId: "live2d", modelId: model.id }}
                  renderMode="live"
                  onError={(code) => setPreviewError(code)}
                />
              </Suspense>
            ) : (
              <div
                data-pet-render-mode="placeholder"
                className="rounded-xl bg-muted/40"
                style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
              />
            )}
            <div className="flex items-center gap-2">
              <label htmlFor="pet-preview-state" className="text-xs text-muted-foreground">
                {t("previewState")}
              </label>
              <select
                id="pet-preview-state"
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={previewState}
                onChange={(e) => {
                  setPreviewShot(null)
                  setPreviewState(e.target.value as PetVisualState)
                }}
              >
                {STATE_KEYS.map((s) => (
                  <option key={s} value={s}>
                    {tStates(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("previewUnavailable")}</p>
        )}

        <Tabs defaultValue="transform">
          <TabsList>
            <TabsTrigger value="transform">{t("tabTransform")}</TabsTrigger>
            <TabsTrigger value="motion">{t("tabMotion")}</TabsTrigger>
            <TabsTrigger value="parameters">{t("tabParameters")}</TabsTrigger>
          </TabsList>
          <TabsContent value="transform">
            <PetModelTransformEditor value={transform} onChange={setTransform} />
          </TabsContent>
          <TabsContent value="motion">
            <PetModelMotionEditor
              motionGroups={model.motionGroups}
              expressionIds={model.expressionIds}
              motionGroupCounts={counts}
              value={overrides}
              onChange={setOverrides}
              onTest={handleTest}
            />
          </TabsContent>
          <TabsContent value="parameters" className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("parameters.description")}</p>
            {PARAMETER_ROLES.map((role) => {
              const value = parameterMapping[role]
              const mode =
                value === null ? "disabled" : typeof value === "string" ? "custom" : "auto"
              return (
                <div key={role} className="grid gap-2 sm:grid-cols-[8rem_8rem_1fr] sm:items-center">
                  <label htmlFor={`pet-parameter-mode-${role}`} className="text-sm">
                    {t(`parameters.roles.${role}`)}
                  </label>
                  <select
                    id={`pet-parameter-mode-${role}`}
                    className="rounded-md border bg-background px-2 py-1 text-sm"
                    value={mode}
                    onChange={(event) =>
                      setParameterRoleMode(
                        role,
                        event.target.value as "auto" | "custom" | "disabled"
                      )
                    }
                  >
                    <option value="auto">{t("parameters.auto")}</option>
                    <option value="custom">{t("parameters.custom")}</option>
                    <option value="disabled">{t("parameters.disabled")}</option>
                  </select>
                  {mode === "custom" && (
                    <input
                      aria-label={t("parameters.parameterIdFor", {
                        role: t(`parameters.roles.${role}`),
                      })}
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={typeof value === "string" ? value : ""}
                      placeholder={t("parameters.parameterIdPlaceholder")}
                      onChange={(event) =>
                        setParameterMapping((current) => ({
                          ...current,
                          [role]: event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              )
            })}
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={handleResetAll}>
            {t("resetAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
