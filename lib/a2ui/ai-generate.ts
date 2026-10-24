/**
 * A2UI AI generation & editing.
 *
 * Drives ONE headless Claude turn — over the same renderer transport the chat
 * hook uses — to emit a complete A2UI app (or an incremental edit), then hands
 * the captured surface back to the caller to apply into the editor store.
 *
 * Why it mirrors `lib/connectors/ai-loop/safe-send-prompt.ts`: raw
 * user-supplied text (the description / edit instruction, plus the current
 * component tree we feed as edit context) MUST pass the `hasNoLeakingPii`
 * red-line before it leaves the device. The renderer chat composer is
 * human-reviewed; this programmatic path is not, so on any leak it does NOT
 * send.
 *
 * Fallback policy (asymmetric on purpose):
 *  - `create`: when no model transport is reachable, the PII gate blocks, or
 *    the turn fails / yields no surface, fall back to the deterministic
 *    template generator (`lib/a2ui/app-generator`) so the button always
 *    produces something. `usedFallback` tells the caller to surface a toast.
 *  - `edit`: the deterministic generator only *rebuilds* whole apps — using it
 *    for an edit would silently wipe the user's work. So an unavailable edit
 *    throws `A2UIAiUnavailableError` and the caller leaves the surface
 *    untouched.
 *
 * The session id passed to `runAndCaptureAssistantReply` is a fresh
 * `crypto.randomUUID()` and is NEVER persisted — the capture wrapper writes no
 * Dexie rows and the sidecar session is memory-only, so generation does not
 * pollute the user's chat history.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply, type CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import { generateAppFromDescription } from "@/lib/a2ui/app-generator"
import { useA2UIStore } from "@/stores/a2ui"
import { useSettingsStore } from "@/stores/settings"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import type { PromptResolutionContext } from "@/lib/prompts/types"
import { A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT } from "@/lib/a2ui/generate-prompts"
import type { ChatSession } from "@cognia/agent-config-types"
import type {
  A2UIComponent,
  A2UIComputedFields,
  A2UIComputedFieldsUpdate,
  A2UIServerMessage,
  A2UIDispatchMessage,
} from "@/types/a2ui/schema"
import { isA2UIComputedFields } from "@/lib/a2ui/computed"
import type { A2UISegmentContent } from "@/types/connectors/segment"

const log = loggers.a2ui

/** Namespaced a2ui-bridge tool prefix — matches `run-and-capture.ts:112`. */
const A2UI_TOOL_PREFIX = "mcp__a2ui-bridge__"

/** The root id the deterministic generator uses (see `a2ui-toolbar` regenerate). */
const FALLBACK_ROOT_ID = "root"

export type A2UIGenerateMode = "create" | "edit"

export interface A2UIGenerateOptions {
  /** Natural-language description (`create`) or edit instruction (`edit`). */
  instruction: string
  mode: A2UIGenerateMode
  /** UI locale; auto-detected from the instruction when omitted. */
  language?: "zh" | "en"
  /**
   * Surface id the model must target. For `edit`, the id of the surface being
   * edited so incremental `update_components` patches land on it. For a
   * workspace `create`, the live canvas surface id. Omit for a hub "new app"
   * (a fresh id is minted and returned).
   */
  surfaceId?: string
  /**
   * Current component tree (`edit` mode) fed to the model as context so it can
   * emit surgical patches instead of a full rebuild.
   */
  currentComponents?: A2UIComponent[]
  /**
   * Live-stream sink: invoked for every a2ui-bridge tool call as the turn
   * streams. Wire it to `useA2UIStore.getState().processMessage` for canvas
   * streaming; omit for non-streaming (hub) callers. The dispatch is remapped
   * onto the caller's `surfaceId`, so the canvas binds deterministically
   * regardless of the id the model chose.
   */
  onDispatch?: (message: A2UIDispatchMessage) => void
  signal?: AbortSignal
  /**
   * Per-generation execution overrides. Folded onto the throwaway session that
   * is handed to `resolveSendOptions`, which reads exactly these fields off a
   * real `ChatSession` row — so a character picked in the hub composer resolves
   * its system prompt / skills / execution policy, and a model or provider
   * override wins over the app default, identically to how the chat composer
   * behaves. Every field is optional and an absent one simply falls through to
   * the app default, so omitting the whole object reproduces the previous
   * behaviour exactly.
   */
  characterId?: string
  model?: string
  providerOverride?: string
}

export interface A2UIGenerateResult {
  surfaceId: string
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
  /** Computed declarations the model wrote (ADR-0240), already validated. */
  computed?: A2UIComputedFields
  rootId: string
  title: string
  /** True when the deterministic template generator produced this result. */
  usedFallback: boolean
}

/** Thrown for an `edit` that could not run against a real model. The caller
 *  should toast and leave the surface untouched (never rebuild). */
export class A2UIAiUnavailableError extends Error {
  constructor(readonly reason: "no-transport" | "pii-blocked" | "turn-failed" | "empty") {
    super(`A2UI AI edit unavailable: ${reason}`)
    this.name = "A2UIAiUnavailableError"
  }
}

/** Is a live model turn reachable from this renderer? Pure-web with no paired
 *  companion has no transport → skip the send entirely. */
export function canReachModel(): boolean {
  return isTauri() || hasWebCompanionTarget()
}

function detectLanguage(text: string): "zh" | "en" {
  return /[一-鿿]/.test(text) ? "zh" : "en"
}

function mintSurfaceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `a2ui-${crypto.randomUUID()}`
  }
  // Deterministic-enough fallback for environments without WebCrypto.
  return `a2ui-${Math.abs(hashString(String(Date.now())))}`
}

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/**
 * Translate an a2ui-bridge tool call into a store dispatch message — a pure
 * renderer mirror of the sidecar `buildDispatch` (`sidecar/a2ui-tools`).
 * `overrideSurfaceId` remaps every op onto the editor-owned surface so the
 * canvas binds regardless of the id the model picked.
 */
export function toolCallToDispatch(
  toolName: string,
  input: Record<string, unknown>,
  overrideSurfaceId?: string
): A2UIDispatchMessage | null {
  if (!toolName.startsWith(A2UI_TOOL_PREFIX)) return null
  const surfaceId =
    overrideSurfaceId ?? (typeof input.surfaceId === "string" ? input.surfaceId : "")
  if (!surfaceId) return null
  const op = toolName.slice(A2UI_TOOL_PREFIX.length)
  // The store refuses a message whose computed map does not validate; so does
  // this mirror, instead of dispatching the surface without it (ADR-0240).
  if (
    input.computed !== undefined &&
    !isA2UIComputedFields(input.computed, { allowRemoval: op === "a2ui_data_model_update" })
  ) {
    return null
  }

  switch (op) {
    case "a2ui_create_surface":
      return {
        type: "createSurface",
        surfaceId,
        surfaceType: normalizeSurfaceType(input.surfaceType),
        title: typeof input.title === "string" ? input.title : undefined,
        catalogId: typeof input.catalogId === "string" ? input.catalogId : undefined,
        widget:
          input.widget && typeof input.widget === "object"
            ? (input.widget as Record<string, unknown>)
            : undefined,
        ...(isA2UIComputedFields(input.computed)
          ? { computed: input.computed as A2UIComputedFields }
          : {}),
      }
    case "a2ui_update_components":
      return {
        type: "updateComponents",
        surfaceId,
        components: Array.isArray(input.components) ? (input.components as A2UIComponent[]) : [],
      }
    case "a2ui_data_model_update":
      return {
        type: "dataModelUpdate",
        surfaceId,
        data: (input.data as Record<string, unknown>) ?? {},
        merge: typeof input.merge === "boolean" ? input.merge : true,
        ...(isA2UIComputedFields(input.computed, { allowRemoval: true })
          ? { computed: input.computed as A2UIComputedFieldsUpdate }
          : {}),
      }
    case "a2ui_delete_surface":
      return { type: "deleteSurface", surfaceId }
    default:
      return null
  }
}

function normalizeSurfaceType(value: unknown): NonNullable<A2UISegmentContent["surfaceType"]> {
  return value === "dialog" || value === "panel" || value === "fullscreen" ? value : "inline"
}

/** Convert a captured surface into the authoritative create→ready message
 *  sequence, remapped onto `surfaceId`. */
export function segmentToMessages(
  surfaceId: string,
  content: A2UISegmentContent
): A2UIServerMessage[] {
  const components = Object.values(content.components) as A2UIComponent[]
  return [
    {
      type: "createSurface",
      surfaceId,
      surfaceType: content.surfaceType ?? "inline",
      title: content.title,
      catalogId: content.catalogId,
      widget: content.widget,
      // Validated where it was captured; re-checked here because the segment
      // type is loose (`Record<string, unknown>`).
      ...(isA2UIComputedFields(content.computed)
        ? { computed: content.computed as A2UIComputedFields }
        : {}),
    },
    { type: "updateComponents", surfaceId, components },
    { type: "dataModelUpdate", surfaceId, data: content.dataModel, merge: false },
    { type: "surfaceReady", surfaceId },
  ]
}

async function buildPrompt(
  opts: A2UIGenerateOptions,
  surfaceId: string,
  language: "zh" | "en"
): Promise<string> {
  // The agent the generation runs as, when the hub composer picked one.
  const context: PromptResolutionContext = opts.characterId ? { agentId: opts.characterId } : {}
  const values = {
    instruction: opts.instruction,
    surfaceId,
    language: language === "zh" ? "Chinese" : "English",
  }

  if (opts.mode === "edit") {
    const currentComponents =
      opts.currentComponents && opts.currentComponents.length > 0
        ? `\n\nCurrent components (JSON):\n${JSON.stringify(opts.currentComponents)}`
        : ""
    return (
      await resolvePromptAsync(A2UI_EDIT_APP_PROMPT, {
        context,
        values: { ...values, currentComponents },
      })
    ).text
  }

  return (await resolvePromptAsync(A2UI_CREATE_APP_PROMPT, { context, values })).text
}

/** Run the model turn and return the first captured surface, or null. */
async function runAiTurn(
  opts: A2UIGenerateOptions,
  surfaceId: string,
  language: "zh" | "en"
): Promise<A2UISegmentContent | null> {
  const prompt = await buildPrompt(opts, surfaceId, language)
  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new DOMException("Aborted", "AbortError")
  }

  // PII red-line: the prompt embeds the instruction AND (edit mode) the current
  // component tree. A leak means we never send.
  if (!hasNoLeakingPii(prompt)) {
    log.warn("A2UI generate: PII gate blocked the prompt; not sending")
    if (opts.mode === "edit") throw new A2UIAiUnavailableError("pii-blocked")
    return null
  }

  const settings = useSettingsStore.getState().settings
  const sessionId = mintSurfaceId() // wire-correlation only; never persisted
  const sendOptions = await resolveSendOptions({
    // Only spread the overrides the caller actually set: `resolveSendOptions`
    // treats an explicitly-undefined field as "no override" already, but
    // keeping them off the object entirely means the session literal stays
    // identical to the pre-override shape when the hub has no preferences.
    session: {
      id: sessionId,
      a2uiEnabled: true,
      ...(opts.characterId ? { characterId: opts.characterId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
    } as unknown as ChatSession,
    appSettings: settings,
  })

  const onEvent = opts.onDispatch
    ? (event: CaptureStreamEvent) => {
        if (event.type !== "tool-call") return
        const message = toolCallToDispatch(event.toolName, event.input, surfaceId)
        if (message) opts.onDispatch?.(message)
      }
    : undefined

  const result = await runAndCaptureAssistantReply(sessionId, prompt, sendOptions, {
    signal: opts.signal,
    execution: { kind: "subagent", label: "A2UI app generation" },
    onEvent,
  })

  const capturedId = result.a2uiSurfaceOrder[0]
  if (!capturedId) return null
  return result.a2uiSurfaces[capturedId] ?? null
}

/**
 * Generate (or edit) an A2UI app. The caller applies the returned pieces:
 *  - hub create → `createCustomApp(title, components, dataModel)`
 *  - workspace regenerate → `replaceSurfaceContent(surfaceId, components, dataModel, rootId)`
 *  - workspace edit → streaming already applied the data operations; reconcile
 *    component patches only. Captured data is partial and must not replace the
 *    live data model.
 */
export async function generateA2UIApp(opts: A2UIGenerateOptions): Promise<A2UIGenerateResult> {
  const language = opts.language ?? detectLanguage(opts.instruction)
  const surfaceId = opts.surfaceId ?? mintSurfaceId()

  if (canReachModel()) {
    try {
      const content = await runAiTurn(opts, surfaceId, language)
      const components = content ? (Object.values(content.components) as A2UIComponent[]) : []
      if (content && components.length > 0) {
        return {
          surfaceId,
          components,
          dataModel: content.dataModel,
          ...(isA2UIComputedFields(content.computed)
            ? { computed: content.computed as A2UIComputedFields }
            : {}),
          rootId: content.rootId || FALLBACK_ROOT_ID,
          title: content.title ?? deriveTitle(opts.instruction, language),
          usedFallback: false,
        }
      }
      // Turn succeeded but produced no surface.
      if (opts.mode === "edit") throw new A2UIAiUnavailableError("empty")
    } catch (err) {
      if (err instanceof A2UIAiUnavailableError) throw err
      log.warn("A2UI generate: model turn failed; falling back", { error: String(err) })
      if (opts.mode === "edit") throw new A2UIAiUnavailableError("turn-failed")
    }
  } else if (opts.mode === "edit") {
    throw new A2UIAiUnavailableError("no-transport")
  }

  // Deterministic fallback — create mode only (edit already threw above).
  const generated = generateAppFromDescription({ description: opts.instruction, language })
  return {
    surfaceId,
    components: generated.components,
    dataModel: generated.dataModel,
    rootId: FALLBACK_ROOT_ID,
    title: generated.name,
    usedFallback: true,
  }
}

function deriveTitle(instruction: string, language: "zh" | "en"): string {
  const generated = generateAppFromDescription({ description: instruction, language })
  return generated.name
}

/** Convenience wrapper for the streaming canvas path: forwards every dispatch
 *  straight into the A2UI store. */
export function streamDispatchToStore(message: A2UIDispatchMessage): void {
  useA2UIStore.getState().processMessage(message)
}
