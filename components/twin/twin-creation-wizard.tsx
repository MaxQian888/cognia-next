"use client"

/**
 * Guided twin-creation wizard.
 *
 * The workbench had no way to create a twin — the registry table (`twins`,
 * schema v34) and `lib/db/twins.ts` CRUD existed but the panel derived its
 * list from `character.twinId` strings and never offered a create path. This
 * wizard is the first-class, guided entry point. Five steps:
 *
 *   1. **Identity**   — purpose template + name / color / description →
 *                        `createTwin` writes the registry row (later steps
 *                        write against the new twinId).
 *   2. **Sources**    — embeds the existing `TwinSourceUploader`; optional.
 *   3. **Runtime**    — readiness check via `buildTwinWorkerConfig`; deep-links
 *                        to Settings and offers to flip the worker on.
 *   4. **Character**  — optionally create a new character or bind an existing
 *                        one to the twin (a twin only "speaks" through a char).
 *   5. **Finish**     — opt-in queue of ingest (+ distill); no auto-spend.
 *
 * State resets on close (handled in `handleOpenChange`) so a reopened wizard
 * starts fresh — avoids a reset effect and its set-state-in-effect lint.
 */

import { useCallback, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Loader2Icon, CheckCircle2Icon, AlertTriangleIcon, ArrowRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { cn } from "@/lib/utils"
import { createTwin, updateTwin } from "@/lib/db/twins"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import { observeTwinRuntimeSettings, saveTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { listCharacters, createCharacter, updateCharacter } from "@/lib/db/characters"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { enqueueDistillJob } from "@/lib/twin/distill"
import { DEFAULT_TWIN_SETTINGS, type Twin } from "@/types/twin"
import { TwinSourceUploader } from "./twin-source-uploader"
import { isTwinWorkerConfigComplete } from "./use-twin-worker"

const TOTAL_STEPS = 5

/**
 * Purpose presets. Each seeds an accent color and a semantic hint; the name
 * and description stay user-entered so the twin gets a real identity. Colors
 * are oklch to match the character avatar palette.
 */
const TEMPLATES = [
  { key: "self", color: "oklch(0.7 0.15 250)" },
  { key: "colleague", color: "oklch(0.7 0.15 160)" },
  { key: "mentor", color: "oklch(0.72 0.16 300)" },
  { key: "predecessor", color: "oklch(0.72 0.15 60)" },
  { key: "blank", color: "oklch(0.7 0.02 260)" },
] as const

type TemplateKey = (typeof TEMPLATES)[number]["key"]
type BindMode = "none" | "new" | "existing"

export interface TwinCreationWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired once the wizard finishes; hands the panel the new twin so it can
   *  select + navigate to it. */
  onCreated: (twin: Twin) => void
}

export function TwinCreationWizard({ open, onOpenChange, onCreated }: TwinCreationWizardProps) {
  const t = useTranslations("twin.wizard")

  // ─── Step 1 — identity ──────────────────────────────────────────────────
  const [step, setStep] = useState(1)
  const [template, setTemplate] = useState<TemplateKey>("self")
  const [name, setName] = useState("")
  const [color, setColor] = useState<string>(TEMPLATES[0].color)
  const [description, setDescription] = useState("")
  const [twin, setTwin] = useState<Twin | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // ─── Step 4 — character binding ─────────────────────────────────────────
  const [bindMode, setBindMode] = useState<BindMode>("none")
  const [newCharName, setNewCharName] = useState("")
  const [existingCharId, setExistingCharId] = useState("")
  const [binding, setBinding] = useState(false)
  const [bindError, setBindError] = useState<string | null>(null)
  const [boundCharacterName, setBoundCharacterName] = useState<string | null>(null)

  // ─── Step 5 — finish ────────────────────────────────────────────────────
  const [queueIngest, setQueueIngest] = useState(true)
  const [queueDistill, setQueueDistill] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  // Guards ingest re-enqueue: if the ingest job is queued but the follow-up
  // distill enqueue throws, the user retries Done — without this flag the
  // ingest job would be queued a second time (duplicate embedding + spend).
  const [ingestQueued, setIngestQueued] = useState(false)

  // ─── Live data ──────────────────────────────────────────────────────────
  const runtimeSettings = useLiveQuery(() => observeTwinRuntimeSettings(), [], undefined)
  const sources = useLiveQuery(
    () => (twin ? listTwinSourcesByTwin(twin.id) : Promise.resolve([])),
    [twin?.id],
    []
  )
  const characters = useLiveQuery(() => listCharacters(), [], [])
  const pendingSources = useMemo(() => sources.filter((s) => s.status === "pending"), [sources])

  // Config completeness is independent of the worker toggle — probe with the
  // toggle forced on so a fully-configured-but-disabled runtime still reads as
  // "ready" (the enable switch below flips the real toggle). Use the pure
  // completeness check, NOT buildTwinWorkerConfig, which would construct (and
  // then discard) a live vector-store + LLM client on every settings emission.
  const runtimeReady = useMemo(() => {
    if (!runtimeSettings) return false
    return isTwinWorkerConfigComplete({ ...runtimeSettings, workerEnabled: true })
  }, [runtimeSettings])

  const resetState = useCallback(() => {
    setStep(1)
    setTemplate("self")
    setName("")
    setColor(TEMPLATES[0].color)
    setDescription("")
    setTwin(null)
    setCreating(false)
    setCreateError(null)
    setBindMode("none")
    setNewCharName("")
    setExistingCharId("")
    setBinding(false)
    setBindError(null)
    setBoundCharacterName(null)
    setQueueIngest(true)
    setQueueDistill(false)
    setFinishing(false)
    setQueueError(null)
    setIngestQueued(false)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (creating || binding || finishing) return
      if (!next) resetState()
      onOpenChange(next)
    },
    [creating, binding, finishing, onOpenChange, resetState]
  )

  const pickTemplate = useCallback((key: TemplateKey) => {
    setTemplate(key)
    const preset = TEMPLATES.find((tpl) => tpl.key === key)
    if (preset) setColor(preset.color)
  }, [])

  // Step 1 → 2: create the registry row (or persist edits when going forward
  // again after a Back). The twinId must exist before the source/bind steps.
  const commitIdentity = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setCreateError(t("nameRequired"))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      if (twin) {
        const updated = await updateTwin(twin.id, {
          name: trimmed,
          color,
          description: description.trim() || undefined,
        })
        if (updated) setTwin(updated)
      } else {
        const created = await createTwin({
          name: trimmed,
          color,
          description: description.trim() || undefined,
        })
        setTwin(created)
      }
      setStep(2)
    } catch (err) {
      setCreateError(t("createError", { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCreating(false)
    }
  }, [name, color, description, twin, t])

  // Step 4 → 5: perform the optional character binding.
  const commitBinding = useCallback(async () => {
    if (!twin) return
    if (bindMode === "none") {
      setBoundCharacterName(null)
      setStep(5)
      return
    }
    setBinding(true)
    setBindError(null)
    try {
      if (bindMode === "new") {
        const charName = newCharName.trim() || twin.name
        await createCharacter({
          name: charName,
          systemPrompt: description.trim() || "",
          avatarColor: color,
          twinId: twin.id,
          twinSettings: DEFAULT_TWIN_SETTINGS,
        })
        setBoundCharacterName(charName)
      } else {
        const target = characters.find((c) => c.id === existingCharId)
        if (!target) {
          setBindError(t("bindError", { reason: t("noCharacters") }))
          return
        }
        await updateCharacter(target.id, {
          twinId: twin.id,
          twinSettings: DEFAULT_TWIN_SETTINGS,
        })
        setBoundCharacterName(target.name)
      }
      setStep(5)
    } catch (err) {
      setBindError(t("bindError", { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBinding(false)
    }
  }, [twin, bindMode, newCharName, description, color, characters, existingCharId, t])

  const canQueueIngest = pendingSources.length > 0 && runtimeReady

  // Step 5 → done: opt-in job queueing, then hand the twin to the panel.
  const finish = useCallback(async () => {
    if (!twin) return
    setFinishing(true)
    setQueueError(null)
    try {
      if (queueIngest && canQueueIngest) {
        // Enqueue ingest at most once, even across retries after a distill
        // failure below — re-running it would double-queue the same sources.
        if (!ingestQueued) {
          await enqueueIngestJob({ twinId: twin.id, sourceIds: pendingSources.map((s) => s.id) })
          setIngestQueued(true)
        }
        if (queueDistill) await enqueueDistillJob(twin.id)
      }
      onCreated(twin)
      resetState()
      onOpenChange(false)
    } catch (err) {
      setQueueError(t("queueError", { reason: err instanceof Error ? err.message : String(err) }))
      setFinishing(false)
    }
  }, [
    twin,
    queueIngest,
    canQueueIngest,
    ingestQueued,
    queueDistill,
    pendingSources,
    onCreated,
    resetState,
    onOpenChange,
    t,
  ])

  const enableWorker = useCallback(async () => {
    if (!runtimeSettings) return
    await saveTwinRuntimeSettings({ ...runtimeSettings, workerEnabled: true })
  }, [runtimeSettings])

  const busy = creating || binding || finishing

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto" data-testid="twin-wizard">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("stepLabel", { current: step, total: TOTAL_STEPS })} · {t(`step${step}Title`)}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <section className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{t("step1Description")}</p>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs uppercase tracking-wide">{t("templateLabel")}</Label>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t("templateLabel")}>
                {TEMPLATES.map((tpl) => (
                  <Button
                    key={tpl.key}
                    type="button"
                    size="sm"
                    variant={template === tpl.key ? "secondary" : "outline"}
                    aria-pressed={template === tpl.key}
                    onClick={() => pickTemplate(tpl.key)}
                    data-testid={`twin-wizard-template-${tpl.key}`}
                    className="gap-1.5"
                  >
                    <span
                      aria-hidden
                      className="inline-block size-2.5 rounded-full"
                      style={{ background: tpl.color }}
                    />
                    {t(`template${cap(tpl.key)}`)}
                  </Button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">{t(`template${cap(template)}Hint`)}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="twin-wizard-name">{t("nameLabel")}</Label>
              <Input
                id="twin-wizard-name"
                data-testid="twin-wizard-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                autoFocus
                disabled={creating}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="twin-wizard-color">{t("colorLabel")}</Label>
              <div className="flex items-center gap-2">
                <input
                  id="twin-wizard-color"
                  type="color"
                  aria-label={t("colorLabel")}
                  value={toHex(color)}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-8 w-12 cursor-pointer rounded border border-input bg-transparent"
                  disabled={creating}
                />
                <code className="text-muted-foreground font-mono text-xs">{color}</code>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="twin-wizard-description">{t("descriptionLabel")}</Label>
              <Textarea
                id="twin-wizard-description"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                disabled={creating}
              />
            </div>

            {createError ? (
              <p className="text-destructive text-sm" role="alert">
                {createError}
              </p>
            ) : null}
          </section>
        ) : null}

        {step === 2 && twin ? (
          <section className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">{t("step2Description")}</p>
            <TwinSourceUploader twinId={twin.id} />
            <p className="text-sm font-medium" data-testid="twin-wizard-sources-count">
              {t("sourcesCount", { count: sources.length })}
            </p>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{t("step3Description")}</p>
            <div
              className={cn(
                "flex items-start gap-2 rounded-md border p-3 text-sm",
                runtimeReady
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-amber-500/40 bg-amber-500/5"
              )}
              data-testid="twin-wizard-readiness"
            >
              {runtimeReady ? (
                <CheckCircle2Icon
                  className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
              ) : (
                <AlertTriangleIcon
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden
                />
              )}
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {runtimeReady ? t("readyTitle") : t("notReadyTitle")}
                </span>
                <span className="text-muted-foreground text-xs">
                  {runtimeReady ? t("readyHint") : t("notReadyHint")}
                </span>
              </div>
            </div>

            {!runtimeReady ? (
              <Button asChild variant="outline" size="sm" className="self-start">
                <a href="/twin?tab=settings" target="_blank" rel="noreferrer">
                  {t("openSettings")}
                </a>
              </Button>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="twin-wizard-worker" className="cursor-pointer text-sm">
                  {t("enableWorker")}
                </Label>
                <p className="text-muted-foreground text-xs">{t("enableWorkerHint")}</p>
              </div>
              <Switch
                id="twin-wizard-worker"
                checked={Boolean(runtimeSettings?.workerEnabled)}
                onCheckedChange={(v) => {
                  if (v) void enableWorker()
                }}
                disabled={Boolean(runtimeSettings?.workerEnabled)}
                aria-label={t("enableWorker")}
              />
            </div>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{t("step4Description")}</p>
            <RadioGroup
              value={bindMode}
              onValueChange={(v) => setBindMode(v as BindMode)}
              className="gap-2"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="none" data-testid="twin-wizard-bind-none" />
                {t("bindNone")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="new" data-testid="twin-wizard-bind-new" />
                {t("bindNew")}
              </label>
              <label
                className={cn(
                  "flex items-center gap-2 text-sm",
                  characters.length === 0 && "opacity-50"
                )}
              >
                <RadioGroupItem
                  value="existing"
                  disabled={characters.length === 0}
                  data-testid="twin-wizard-bind-existing"
                />
                {t("bindExisting")}
              </label>
            </RadioGroup>

            {bindMode === "new" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="twin-wizard-char-name">{t("newCharacterNameLabel")}</Label>
                <Input
                  id="twin-wizard-char-name"
                  data-testid="twin-wizard-char-name"
                  value={newCharName}
                  onChange={(e) => setNewCharName(e.target.value)}
                  placeholder={t("newCharacterNamePlaceholder")}
                  disabled={binding}
                />
              </div>
            ) : null}

            {bindMode === "existing" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="twin-wizard-char-existing">{t("existingCharacterLabel")}</Label>
                <NativeSelect
                  id="twin-wizard-char-existing"
                  data-testid="twin-wizard-char-existing"
                  value={existingCharId}
                  onChange={(e) => setExistingCharId(e.target.value)}
                  className="w-full"
                  disabled={binding}
                >
                  <NativeSelectOption value="">
                    {t("existingCharacterPlaceholder")}
                  </NativeSelectOption>
                  {characters.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            ) : null}

            {bindError ? (
              <p className="text-destructive text-sm" role="alert">
                {bindError}
              </p>
            ) : null}
          </section>
        ) : null}

        {step === 5 && twin ? (
          <section className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">{t("step5Description")}</p>
            <dl className="bg-muted/40 grid grid-cols-3 gap-2 rounded-md border p-3 text-sm">
              <dt className="text-muted-foreground text-xs">{t("summaryName")}</dt>
              <dd className="col-span-2 truncate font-medium">{twin.name}</dd>
              <dt className="text-muted-foreground text-xs">{t("summarySources")}</dt>
              <dd className="col-span-2">{sources.length}</dd>
              <dt className="text-muted-foreground text-xs">{t("summaryCharacter")}</dt>
              <dd className="col-span-2 truncate">
                {boundCharacterName ?? t("summaryCharacterNone")}
              </dd>
            </dl>

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={queueIngest}
                onCheckedChange={(v) => setQueueIngest(v === true)}
                disabled={!canQueueIngest}
                data-testid="twin-wizard-queue-ingest"
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{t("queueIngest")}</span>
                <span className="text-muted-foreground text-xs">
                  {canQueueIngest ? t("queueIngestHint") : t("queueIngestBlocked")}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={queueDistill}
                onCheckedChange={(v) => setQueueDistill(v === true)}
                disabled={!canQueueIngest || !queueIngest}
                data-testid="twin-wizard-queue-distill"
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{t("queueDistill")}</span>
                <span className="text-muted-foreground text-xs">{t("queueDistillHint")}</span>
              </span>
            </label>

            {queueError ? (
              <p className="text-destructive text-sm" role="alert">
                {queueError}
              </p>
            ) : null}
          </section>
        ) : null}

        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <div>
            {step > 1 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep((s) => s - 1)}
                disabled={busy}
                data-testid="twin-wizard-back"
              >
                {t("back")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={busy}
              >
                {t("cancel")}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {step === 1 ? (
              <Button
                type="button"
                onClick={() => void commitIdentity()}
                disabled={creating || !name.trim()}
                data-testid="twin-wizard-next"
              >
                {creating ? (
                  <>
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                    {t("creating")}
                  </>
                ) : (
                  t("next")
                )}
              </Button>
            ) : null}

            {step === 2 || step === 3 ? (
              <Button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                data-testid="twin-wizard-next"
              >
                {t("next")}
              </Button>
            ) : null}

            {step === 4 ? (
              <Button
                type="button"
                onClick={() => void commitBinding()}
                disabled={binding || (bindMode === "existing" && !existingCharId)}
                data-testid="twin-wizard-next"
              >
                {binding ? (
                  <>
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                    {t("creating")}
                  </>
                ) : (
                  t("next")
                )}
              </Button>
            ) : null}

            {step === 5 ? (
              <Button
                type="button"
                onClick={() => void finish()}
                disabled={finishing}
                data-testid="twin-wizard-done"
              >
                {finishing ? (
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                ) : (
                  <ArrowRightIcon className="mr-1.5 size-3.5" aria-hidden />
                )}
                {t("done")}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * `<input type="color">` only accepts `#rrggbb`. Twin colors may be oklch or
 * arbitrary CSS — fall back to a neutral swatch so the picker still renders
 * (the real value is preserved in state and shown as a code string).
 */
function toHex(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#6366f1"
}
