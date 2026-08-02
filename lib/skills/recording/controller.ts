/**
 * Everything the recorder *does*, as opposed to everything it *is*.
 *
 * The store is a reducer plus a snapshot; this module owns the native
 * subscription, the Dexie checkpointing, the asset cache, and the async
 * orchestration. Keeping them apart is what makes the tests honest: a test
 * drives the controller and `await`s it, instead of racing a floating promise
 * started inside a React effect. That is the direct cause of the `act(...)`
 * warnings this repo has elsewhere.
 *
 * A module, not a hook, because most of its callers are not components: the
 * slash-command handler, the command palette, the app shortcut, the plugin's
 * own command, and startup recovery.
 */

import { toast } from "sonner"

import {
  checkpointRecording,
  createRecording,
  getRecording,
  listUnfinishedRecordings,
  setRecordingStatus,
} from "@/lib/db/skill-recordings"
import { SKILL_CATEGORIES } from "@/lib/skills/categories"
import { useRecorderStore } from "@/stores/skills/recorder-store"

import { buildResourceDrafts, planPromotion } from "./asset-promotion"
import { buildGenerationEnvelope, type GenerationEnvelope } from "./generation-envelope"
import { CATEGORY_IDS, generateSkillFromEnvelope } from "./generate-skill"
import { deriveInputVariables, mergeInputVariables } from "./input-variables"
import { saveRecordedSkill } from "./persist-recorded-skill"
import {
  onRecordEvent,
  recordListRecoverable,
  recordLoadBundle,
  recordPause,
  recordPreflight,
  recordReadAsset,
  recordResume,
  recordStart,
  recordStatus,
  recordStop,
  recordUndoLast,
} from "./recorder-client"
import { reconcileOnStartup } from "./recovery"
import { hasLiveCapture } from "./state-machine"
import { includedSteps, selectedScreenshotIds } from "./step-model"
import { collectRegisteredToolNames } from "./tool-catalog"
import type { CaptureScope, InterruptReason, RecordedStep, RecordingId } from "./types"

/**
 * How many frames to keep decoded in memory.
 *
 * Frames are fetched on demand rather than held: a 400-step recording is
 * hundreds of megabytes of base64, and the review UI shows a handful at a time.
 * The cache exists so scrolling back over the same few steps is instant, not so
 * the whole recording is resident.
 */
const ASSET_CACHE_LIMIT = 64
/** Coalesce Dexie writes while steps stream in at human speed. */
const CHECKPOINT_DEBOUNCE_MS = 750

let unsubscribe: (() => void) | null = null
let checkpointTimer: ReturnType<typeof setTimeout> | null = null
const assetCache = new Map<string, string>()

function cacheAsset(assetId: string, bytes: string): void {
  assetCache.delete(assetId)
  assetCache.set(assetId, bytes)
  while (assetCache.size > ASSET_CACHE_LIMIT) {
    const oldest = assetCache.keys().next().value
    if (oldest === undefined) break
    assetCache.delete(oldest)
  }
}

function store() {
  return useRecorderStore.getState()
}

function scheduleCheckpoint(): void {
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null
    void flushCheckpoint()
  }, CHECKPOINT_DEBOUNCE_MS)
}

/**
 * Persist the review state.
 *
 * Note what is *not* written: the captured steps. Those live in the native
 * bundle and are replayed from it — this row only holds the user's edits over
 * them, which is what keeps a saved source version immutable.
 */
async function flushCheckpoint(): Promise<void> {
  const state = store()
  if (!state.recordingId) return
  await checkpointRecording(state.recordingId, {
    edits: state.edits,
    inputVariables: state.inputVariables,
    selectedAssetIds: selectedScreenshotIds(state.steps),
    stepCount: state.capturedSteps.length,
    includedCount: includedSteps(state.steps).length,
    draft: state.draft ?? undefined,
    generation: state.generation ?? undefined,
  }).catch(() => undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// Native event plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attach to the native event channel.
 *
 * Idempotent, and attached **before** `record_start` is called — a subscription
 * opened afterwards can miss the steps the user performs in the first few
 * hundred milliseconds, which is exactly when they are checking that recording
 * works.
 */
export function attachNativeEvents(): void {
  if (unsubscribe) return
  unsubscribe = onRecordEvent((event) => {
    const state = store()
    switch (event.type) {
      case "started":
        state.dispatch({
          type: "NATIVE_STARTED",
          recordingId: event.recordingId,
          startedAt: event.startedAt,
          scope: event.scope,
          limits: event.limits,
        })
        break
      case "step":
        state.appendStep(event.step)
        state.dispatch({ type: "STEP", step: event.step })
        scheduleCheckpoint()
        break
      case "paused":
        state.dispatch({ type: "PAUSE" })
        break
      case "resumed":
        state.dispatch({ type: "RESUME" })
        break
      case "undone":
        state.dropStep(event.seq)
        state.dispatch({ type: "UNDONE", seq: event.seq })
        scheduleCheckpoint()
        break
      case "limitWarning":
        state.dispatch({ type: "USAGE", usage: [event.usage] })
        break
      case "stopped":
        // The bundle is authoritative; `finishFromBundle` reads it rather than
        // trusting the step list the renderer accumulated.
        void finishFromBundle(event.recordingId)
        break
      case "interrupted":
        void handleInterrupt(event.recordingId, event.reason)
        break
      case "error":
        // Where a native error lands depends on what was in flight. `error` is
        // emitted from the session as well as from arming, and `PREFLIGHT_FAIL`
        // is legal only from `preflight` — routing every one of them there would
        // drop a mid-capture hook failure on the floor with a dev warning.
        if (state.phase === "preflight") {
          state.dispatch({
            type: "PREFLIGHT_FAIL",
            error: { code: "nativeError", detail: event.message, retriable: true },
          })
        } else if (hasLiveCapture(state.phase)) {
          // Interrupt rather than stop: the journal is preserved and everything
          // captured so far stays recoverable.
          state.dispatch({ type: "INTERRUPT", reason: "nativeFailure" })
          toast.error(event.message)
        } else {
          // Review, draft and save are not sessions — a late native complaint
          // must not throw away work the user is in the middle of.
          toast.error(event.message)
        }
        break
    }
  })
}

export function detachNativeEvents(): void {
  unsubscribe?.()
  unsubscribe = null
}

async function finishFromBundle(recordingId: RecordingId): Promise<void> {
  const bundle = await recordLoadBundle(recordingId).catch(() => null)
  const state = store()
  if (!bundle) {
    state.dispatch({ type: "INTERRUPT", reason: "nativeFailure" })
    return
  }
  applyBundle(bundle.steps, bundle.ignoredCount, recordingId, bundle.totalBytes)
}

function applyBundle(
  steps: RecordedStep[],
  ignoredCount: number,
  bundleId: RecordingId,
  bundleBytes: number
): void {
  const state = store()
  state.setCapturedSteps(steps)
  state.dispatch({ type: "STOPPED", steps, ignoredCount, bundleId })

  // Variable suggestions are re-derived whenever the timeline changes, but a
  // confirmation the user already gave survives — otherwise editing one step
  // would silently un-answer every question they had already answered.
  const derived = deriveInputVariables(store().steps)
  const merged = mergeInputVariables(derived, store().inputVariables)
  store().dispatch({ type: "SET_VARIABLES", variables: merged })

  if (state.recordingId) {
    void checkpointRecording(state.recordingId, {
      status: "captured",
      bundleId,
      bundleBytes,
      stepCount: steps.length,
    }).catch(() => undefined)
  }
}

async function handleInterrupt(recordingId: RecordingId, reason: InterruptReason): Promise<void> {
  store().dispatch({ type: "INTERRUPT", reason })
  await checkpointRecording(recordingId, {
    status: "interrupted",
    interrupt: { reason, from: store().phase, at: Date.now() },
  }).catch(() => undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow
// ─────────────────────────────────────────────────────────────────────────────

export async function runPreflight(): Promise<boolean> {
  const state = store()
  if (!state.dispatch({ type: "PREFLIGHT_START" })) return false
  try {
    const report = await recordPreflight()
    state.setPreflight(report)
    if (!report.ready) {
      state.dispatch({
        type: "PREFLIGHT_FAIL",
        error: {
          code: report.blockers[0] ?? "unknown",
          retriable: true,
        },
      })
      return false
    }
    state.dispatch({ type: "PREFLIGHT_OK" })
    return true
  } catch (error) {
    state.setPreflight(null)
    state.dispatch({
      type: "PREFLIGHT_FAIL",
      error: {
        code: "preflightFailed",
        detail: error instanceof Error ? error.message : String(error),
        retriable: true,
      },
    })
    return false
  }
}

/**
 * Begin a recording.
 *
 * The id is minted here and passed *into* the native call so the Dexie row and
 * the bundle directory share one identity — which is what lets a crash be
 * recovered without a lookup table.
 */
export async function startRecording(scope: CaptureScope): Promise<boolean> {
  const state = store()
  const ok = await runPreflight()
  if (!ok) return false

  const recordingId = crypto.randomUUID()
  attachNativeEvents()
  await createRecording({ id: recordingId }).catch(() => undefined)

  try {
    await recordStart({
      recordingId,
      scope,
      captureScreenshots: state.options.captureScreenshots,
    })
    return true
  } catch (error) {
    await setRecordingStatus(recordingId, "discarded").catch(() => undefined)
    store().dispatch({
      type: "PREFLIGHT_FAIL",
      error: {
        code: "startFailed",
        detail: error instanceof Error ? error.message : String(error),
        retriable: true,
      },
    })
    return false
  }
}

export async function pauseRecording(): Promise<void> {
  await recordPause().catch(() => undefined)
}

export async function resumeRecording(): Promise<void> {
  await recordResume().catch(() => undefined)
}

export async function undoLastStep(): Promise<void> {
  await recordUndoLast().catch(() => undefined)
}

export async function stopRecording(): Promise<void> {
  const state = store()
  if (!state.dispatch({ type: "STOP_REQUESTED" })) return
  try {
    const bundle = await recordStop()
    applyBundle(bundle.steps, bundle.ignoredCount, bundle.manifest.recordingId, bundle.totalBytes)
  } catch (error) {
    store().dispatch({ type: "INTERRUPT", reason: "nativeFailure" })
    toast.error(error instanceof Error ? error.message : String(error))
  }
}

/** Read a frame, through the cache. */
export async function loadAssetBytes(assetId: string): Promise<string | null> {
  const cached = assetCache.get(assetId)
  if (cached) return cached
  const bundleId = store().bundleId
  if (!bundleId) return null
  const payload = await recordReadAsset(bundleId, assetId).catch(() => null)
  if (!payload) return null
  cacheAsset(assetId, payload.bytes)
  return payload.bytes
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the outbound payload for preview.
 *
 * The same object is handed to `generate` — the preview is not a rendering of
 * what will be sent, it *is* what will be sent.
 */
export async function buildEnvelope(locale: string): Promise<GenerationEnvelope> {
  const state = store()
  const toolCatalog = await collectRegisteredToolNames()
  return buildGenerationEnvelope(
    state.steps,
    {
      variables: state.inputVariables,
      locale: state.options.localeOverride ?? locale,
      toolCatalog,
    },
    CATEGORY_IDS
  )
}

export interface GenerateOptions {
  locale: string
  /** `null` when no utility model resolves; the caller falls back to a template. */
  client: { complete: (prompt: string, opts: unknown) => Promise<string> } | null
  provider: string
  model: string
  fallbackName: string
  asCandidate?: boolean
}

export async function generate(options: GenerateOptions): Promise<boolean> {
  const state = store()
  if (!state.dispatch({ type: "GENERATE_REQUESTED" })) return false

  const envelope = await buildEnvelope(options.locale)
  if (!options.client) {
    store().dispatch({
      type: "GENERATE_FAILED",
      error: { code: "noModel", retriable: false },
    })
    return false
  }

  try {
    const toolCatalog = await collectRegisteredToolNames()
    const result = await generateSkillFromEnvelope(envelope, options.client as never, {
      toolCatalog,
      fallbackName: options.fallbackName,
    })
    store().setToolsConfirmed(false)
    store().dispatch({
      type: "GENERATED",
      draft: result.draft,
      provenance: {
        provider: options.provider,
        model: options.model,
        locale: store().options.localeOverride ?? options.locale,
        redacted: result.redacted,
        generatedAt: Date.now(),
        promptHash: hashPrompt(envelope.userPrompt),
      },
      asCandidate: options.asCandidate ?? false,
    })
    void flushCheckpoint()
    return true
  } catch (error) {
    store().dispatch({
      type: "GENERATE_FAILED",
      error: {
        code: "generationFailed",
        detail: error instanceof Error ? error.message : String(error),
        retriable: true,
      },
    })
    return false
  }
}

/** Cheap, stable, non-cryptographic — it ties a draft to its payload, nothing more. */
export function hashPrompt(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i)
    hash |= 0
  }
  return (hash >>> 0).toString(16)
}

/** Adopt a fully-formed draft the caller built without a model. */
export function adoptManualDraft(
  draft: import("./state-machine").GeneratedDraft,
  locale: string
): void {
  const state = store()
  if (!state.dispatch({ type: "GENERATE_REQUESTED" })) return
  store().dispatch({
    type: "GENERATED",
    draft,
    provenance: {
      provider: "none",
      model: "manual-template",
      locale,
      redacted: false,
      generatedAt: Date.now(),
      promptHash: "",
    },
    asCandidate: false,
  })
  void flushCheckpoint()
}

// ─────────────────────────────────────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────────────────────────────────────

export async function saveSkill(altFor: (index: number) => string): Promise<string | null> {
  const state = store()
  if (!state.draft || !state.recordingId || !state.bundleId) return null
  if (!state.dispatch({ type: "SAVE_REQUESTED" })) return null

  try {
    const { assets } = planPromotion(state.steps)
    const bytesById = new Map<string, string>()
    for (const asset of assets) {
      const bytes = await loadAssetBytes(asset.assetId)
      if (bytes) bytesById.set(asset.assetId, bytes)
    }
    const resources = buildResourceDrafts(assets, bytesById)

    const { injectImageLinks } = await import("./asset-promotion")
    const content = injectImageLinks(state.draft.content, assets, altFor)

    const { skillId } = await saveRecordedSkill({
      recordingId: state.recordingId,
      bundleId: state.bundleId,
      draft: { ...state.draft, content },
      resources,
      edits: state.edits,
      inputVariables: state.inputVariables,
      selectedAssetIds: selectedScreenshotIds(state.steps),
      generation: state.generation,
      stepCount: state.capturedSteps.length,
      includedCount: includedSteps(state.steps).length,
      bundleBytes: 0,
    })
    store().dispatch({ type: "SAVED", skillId })
    return skillId
  } catch (error) {
    // The transaction rolled back, so nothing the user wrote is gone.
    store().dispatch({
      type: "SAVE_FAILED",
      error: {
        code: "saveFailed",
        detail: error instanceof Error ? error.message : String(error),
        retriable: true,
      },
    })
    return null
  }
}

/**
 * Open a chat containing only the recorded skill.
 *
 * Two fields, because one alone does not produce a trial:
 *
 * - `trialSkillId` is what actually loads the skill. The recording was saved
 *   `disabled` on purpose — enabling it is the user's separate act once the
 *   trial convinces them — so the ordinary resolution path, which honours that
 *   flag, would inject nothing. `resolveSendOptions` reads this field, loads
 *   the skill by id, and makes it the whole set.
 * - `disabledSkillIds` is every *other* enabled skill, so the composer chips and
 *   the per-session badge agree with the send path about what is inert. Without
 *   it the UI would advertise a skill mix the send does not use.
 */
export async function startControlledTrial(skillId: string): Promise<string | null> {
  const { createSession } = await import("@/lib/db/sessions")
  const { getDb } = await import("@/lib/db/schema")

  const enabled = await getDb().skills.where("status").equals("enabled").primaryKeys()
  const disabledSkillIds = (enabled as string[]).filter((id) => id !== skillId)

  const session = await createSession({
    title: "Skill trial",
    kind: "direct",
    disabledSkillIds,
    trialSkillId: skillId,
  } as never).catch(() => null)
  if (!session) return null
  store().dispatch({ type: "TRIAL_STARTED", sessionId: session.id })
  return session.id
}

/** Enable the skill. Reachable only after the user confirms the trial worked. */
export async function confirmTrialAndEnable(skillId: string): Promise<void> {
  const { setSkillStatus } = await import("@/lib/db/skills")
  await setSkillStatus(skillId, "enabled")
  store().dispatch({ type: "TRIAL_CONFIRMED" })
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile with the native side at startup, or when the Sheet reopens.
 *
 * Nothing is auto-deleted and nothing is auto-resumed: a recording the user has
 * not seen is not ours to discard, and silently rejoining one they thought had
 * ended would be worse.
 */
export async function recoverOnStartup(): Promise<void> {
  const [native, rows, bundles] = await Promise.all([
    recordStatus().catch(() => null),
    listUnfinishedRecordings().catch(() => []),
    recordListRecoverable().catch(() => []),
  ])
  if (!native) return

  const plan = reconcileOnStartup(native, rows, bundles)
  const state = store()
  switch (plan.action) {
    case "reattach":
    case "adopt": {
      attachNativeEvents()
      if (plan.action === "adopt") {
        await createRecording({ id: plan.recordingId, status: "recording" }).catch(() => undefined)
      }
      const row = await getRecording(plan.recordingId)
      state.dispatch({
        type: "REATTACH",
        snapshot: {
          ...state,
          phase: native.phase === "paused" ? "paused" : "recording",
          recordingId: plan.recordingId,
          bundleId: plan.recordingId,
          startedAt: native.startedAt ?? null,
          scope: native.scope ?? null,
          usage: native.usage,
          inputVariables: row?.inputVariables ?? [],
        },
      })
      if (row?.edits) state.setEdits(row.edits)
      break
    }
    case "offerInterrupted":
    case "offerResume": {
      const bundle = await recordLoadBundle(plan.recordingId).catch(() => null)
      if (!bundle) return
      const row = await getRecording(plan.recordingId)
      state.setCapturedSteps(bundle.steps)
      if (row?.edits) state.setEdits(row.edits)
      state.dispatch({
        type: "REATTACH",
        snapshot: {
          ...store(),
          phase: "review",
          recordingId: plan.recordingId,
          bundleId: bundle.manifest.recordingId,
          startedAt: bundle.manifest.startedAt,
          scope: bundle.manifest.scope,
          ignoredCount: bundle.ignoredCount,
          inputVariables: row?.inputVariables ?? [],
          draft: row?.draft ?? null,
        },
      })
      break
    }
    case "none":
      break
  }
}

/** Category ids, for the setup and draft pickers. */
export const RECORDER_CATEGORY_IDS = SKILL_CATEGORIES.map((c) => c.id)

/** Test seam. */
export function __resetControllerForTesting(): void {
  detachNativeEvents()
  if (checkpointTimer) clearTimeout(checkpointTimer)
  checkpointTimer = null
  assetCache.clear()
}
