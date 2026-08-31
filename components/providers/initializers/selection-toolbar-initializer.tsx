"use client"

/**
 * Main-window half of the selection toolbar.
 *
 * Three of the six actions are prompts and land in the composer with the window
 * raised. The other two run here *without* raising the window — stashing a note
 * or reading text aloud must not interrupt whatever the user is doing in
 * another app — and report back to the overlay, which stays on screen showing a
 * spinner, a ✓, a PII warning, or a player until they settle.
 *
 * The memory path in particular has to report: `storeExternalMemory` *returns*
 * `{ok: false, reason: "pii_blocked"}` rather than throwing, so a fire-and-
 * forget write would be a silent no-op whenever the main window is in the tray.
 */

import { useEffect, useRef } from "react"
import { emitTo, listen } from "@tauri-apps/api/event"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"

import { startNewSession } from "@/lib/chat/start-session"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { storeExternalMemory } from "@/lib/memory/api/store-memory"
import {
  speakSelection,
  stopSelectionSpeech,
  watchSelectionSpeech,
} from "@/lib/tts/speak-selection"
import {
  SELECTION_RESULT_EVENT,
  SELECTION_ACTION_CATALOG_EVENT,
  SELECTION_ACTION_REQUEST_EVENT,
  SELECTION_ACTION_RESULT_EVENT,
  SELECTION_OPEN_RESULT_EVENT,
  SELECTION_CANDIDATE_EVENT,
  SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF,
  SELECTION_SPEECH_EVENT,
  SELECTION_SPEECH_STOP_EVENT,
  SELECTION_STAGE_EVENT,
  SELECTION_TOOLBAR_LABEL,
  takePendingSelectionStage,
  getCurrentSelectionCandidate,
  type SelectionActionRequestPayload,
  type SelectionOpenResultPayload,
  type ExternalSelectionCandidate,
  type SelectionStagePayload,
} from "@/lib/tauri/selection-toolbar"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { ExternalSelectionRef } from "@/types/artifact/artifact"
import { classifySelection } from "@/lib/selection/classify-selection"
import { selectionIsSecure } from "@/components/selection-toolbar/selection-toolbar-actions"
import {
  getQuickAction,
  listQuickActions,
  subscribeQuickActions,
} from "@/lib/plugin/registries/quick-action-registry"
import {
  executePluginSelectionQuickAction,
  SelectionQuickActionError,
} from "@/lib/selection/plugin-actions"
import {
  pluginActionIsEligible,
  type SelectionHostActionDescriptor,
} from "@/lib/selection/action-layout"
import { lookupPluginMessage } from "@/lib/i18n/plugin-i18n-registry"
import { getPref } from "@/lib/tauri/store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { enhancePrompt, ENHANCE_MODES, type EnhanceMode } from "@/lib/chat/completion/enhance"
import { useSettingsStore } from "@/stores/settings/settings-store"

const PLUGIN_ACTION_TIMEOUT_MS = 30_000

function localizedPluginActionTitle(
  pluginId: string,
  locale: string,
  labelKey: string | undefined,
  fallback: string
): string {
  if (!labelKey) return fallback
  return lookupPluginMessage(locale, `plugin.${pluginId}.${labelKey}`) ?? fallback
}

function pluginCatalogForCandidate(
  candidate: ExternalSelectionCandidate,
  locale: string,
  rewrite: SelectionHostActionDescriptor
): SelectionHostActionDescriptor[] {
  // Same rule the built-in table applies, at the other end of the wire. Rust
  // refuses to read a password field and the overlay withholds every built-in
  // action for one, but this catalog is assembled here and shipped over, so
  // without the gate a secure candidate that somehow arrived would be offered
  // to every plugin that registered for the selection surface.
  if (selectionIsSecure(candidate)) return []
  const classification = classifySelection(candidate.text, { uiLocale: locale })
  const plugins = listQuickActions("selection").flatMap((entry) => {
    if (!entry.selection) return []
    const descriptor: SelectionHostActionDescriptor = {
      id: entry.fullId,
      title: localizedPluginActionTitle(entry.pluginId, locale, entry.labelKey, entry.title),
      source: "plugin",
      pluginId: entry.pluginId,
      attribution: entry.pluginId,
      icon: entry.icon,
      accelerator: entry.accelerator,
      directReplace: entry.selection.output === "replace",
      ...entry.selection,
    }
    return pluginActionIsEligible(descriptor, {
      origin: candidate.origin,
      contentTypes: classification.types,
      chars: Array.from(candidate.text).length,
    })
      ? [descriptor]
      : []
  })
  return [rewrite, ...plugins]
}

function rewriteDescriptor(
  t: ReturnType<typeof useTranslations<"selectionToolbar">>
): SelectionHostActionDescriptor {
  return {
    id: "cognia:rewrite",
    title: t("rewrite.title"),
    source: "cognia",
    attribution: t("cogniaAttribution"),
    input: "text",
    output: "replace",
    origins: ["accessibility", "clipboard", "ocr"],
    directReplace: true,
    children: ENHANCE_MODES.map((mode) => ({
      id: `cognia:rewrite:${mode}`,
      title: t(`rewrite.modes.${mode}` as never),
    })),
  }
}

function promptForAction(
  action: SelectionStagePayload["action"],
  candidate: ExternalSelectionCandidate,
  locale: string,
  t: ReturnType<typeof useTranslations<"selectionToolbar">>
): string | null {
  const classification = classifySelection(candidate.text, { uiLocale: locale })
  switch (action.kind) {
    case "copy":
    case "ask":
    case "remember":
    case "speak":
    // `launch` actions never reach the composer — Rust hands them to the
    // browser or the mail client and the toolbar leaves.
    case "openLink":
    case "composeEmail":
    case "searchWeb":
      return null
    case "explain":
      return classification.types.includes("code") ? t("prompts.explainCode") : t("prompts.explain")
    case "translate":
      return classification.script
        ? t("prompts.translateDetected", {
            script: classification.script,
            language: t(`languages.${action.targetLocale}` as never),
          })
        : t("prompts.translate", {
            language: t(`languages.${action.targetLocale}` as never),
          })
    case "convertUnit":
      return classification.types.includes("measurement")
        ? t("prompts.convertMeasurement")
        : t("prompts.convertUnit")
  }
}

async function reportResult(candidateId: string, ok: boolean, reason?: string): Promise<void> {
  await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_RESULT_EVENT, { candidateId, ok, reason })
}

async function rememberSelection(candidate: ExternalSelectionCandidate): Promise<void> {
  try {
    const result = await storeExternalMemory(
      {
        text: candidate.text,
        tags: ["selection", candidate.sourceApp].filter(Boolean),
        source: {},
      },
      { channel: "selection" }
    )
    await reportResult(candidate.id, result.ok, result.ok ? undefined : result.reason)
  } catch {
    await reportResult(candidate.id, false)
  }
}

export function SelectionToolbarInitializer() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations("selectionToolbar")
  const tRef = useRef(t)
  const localeRef = useRef(locale)
  useEffect(() => {
    tRef.current = t
    localeRef.current = locale
  }, [locale, t])

  useEffect(() => {
    let alive = true
    const unlistens: Array<() => void | Promise<void>> = []
    // One playback subscription at a time — a second `speak` supersedes the
    // first, exactly as the single orchestrator does.
    let stopWatching: (() => void) | null = null
    const handledRequests = new Set<string>()

    const publishPluginCatalog = async (candidate?: ExternalSelectionCandidate | null) => {
      const current = candidate ?? (await getCurrentSelectionCandidate())
      if (!alive || !current) return
      await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_CATALOG_EVENT, {
        candidateId: current.id,
        actions: pluginCatalogForCandidate(
          current,
          localeRef.current,
          rewriteDescriptor(tRef.current)
        ),
      })
    }

    const executeRewrite = async (
      request: SelectionActionRequestPayload,
      candidate: ExternalSelectionCandidate,
      mode: EnhanceMode
    ) => {
      const appSettings = useSettingsStore.getState().settings
      const client =
        buildUtilityLlmClient({
          session: null,
          appSettings,
          override: appSettings?.composerAssistance?.model,
          featureId: "selection-rewrite",
        }) ?? buildHeadlessTurnLlmClient({ session: null, label: "Selection rewrite" })
      if (!client) {
        await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
          ...request,
          ok: false,
          error: "noModel",
        })
        return
      }
      const enhanced = await enhancePrompt(candidate.text, mode, { client })
      if (enhanced.kind === "skipped") {
        await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
          ...request,
          ok: false,
          error: enhanced.reason === "pii" ? "piiBlocked" : "noOutput",
        })
        return
      }
      const allowlist = (await getPref<string[]>(SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF)) ?? []
      await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
        ...request,
        ok: true,
        result:
          enhanced.kind === "variants"
            ? { kind: "variants", variants: enhanced.variants }
            : { kind: "text", text: enhanced.text },
        attribution: tRef.current("cogniaAttribution"),
        output: "replace",
        directReplaceAllowed:
          allowlist.includes("cognia:rewrite") || allowlist.includes(request.actionId),
      })
    }

    const executePluginAction = async (request: SelectionActionRequestPayload) => {
      if (handledRequests.has(request.requestId)) return
      handledRequests.add(request.requestId)
      const candidate = await getCurrentSelectionCandidate()
      const rewriteMode = request.actionId.startsWith("cognia:rewrite:")
        ? (request.actionId.slice("cognia:rewrite:".length) as EnhanceMode)
        : null
      const entry = getQuickAction(request.actionId)
      if (!alive) return
      if (
        !candidate ||
        candidate.id !== request.candidateId ||
        // The catalog for a password field is empty, so no button can reach
        // here. The gate is repeated on the execution path anyway because this
        // is the last point before the text is handed to a plugin or a model,
        // and "the UI would never ask" is not a property worth staking a
        // password on.
        selectionIsSecure(candidate) ||
        (rewriteMode === null &&
          (!entry || !entry.surfaces.includes("selection") || !entry.selection))
      ) {
        await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
          ...request,
          ok: false,
          error: "stale",
        })
        return
      }
      if (rewriteMode && ENHANCE_MODES.includes(rewriteMode)) {
        try {
          await executeRewrite(request, candidate, rewriteMode)
        } catch {
          await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
            ...request,
            ok: false,
            error: "failed",
          })
        }
        return
      }
      // Reachable for a `cognia:rewrite:` id whose suffix is not an enhance
      // mode (a stale overlay, a renamed mode, a replayed request): the guard
      // above lets it through because `rewriteMode` is non-null, and the branch
      // above skips it because the mode is unknown. Returning silently left the
      // overlay spinning forever, and `handledRequests` already suppressed the
      // retry. Every path out of here has to settle the request.
      if (!entry?.selection) {
        await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
          ...request,
          ok: false,
          error: "stale",
        })
        return
      }
      try {
        const classification = classifySelection(candidate.text, { uiLocale: localeRef.current })
        const result = await Promise.race([
          executePluginSelectionQuickAction(entry, candidate, classification, {
            reason: tRef.current("permissionRequest", {
              title: localizedPluginActionTitle(
                entry.pluginId,
                localeRef.current,
                entry.labelKey,
                entry.title
              ),
            }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("selection plugin action timed out")),
              PLUGIN_ACTION_TIMEOUT_MS
            )
          ),
        ])
        // Disable/uninstall during execution invalidates the result rather than
        // letting a now-untrusted action paint or replace text.
        if (getQuickAction(request.actionId) !== entry) {
          throw new SelectionQuickActionError("ineligible", "selection action became stale")
        }
        const allowlist = (await getPref<string[]>(SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF)) ?? []
        await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
          ...request,
          ok: true,
          result,
          attribution: entry.pluginId,
          output: entry.selection.output,
          directReplaceAllowed:
            entry.selection.output === "replace" && allowlist.includes(entry.fullId),
        })
      } catch (error) {
        const code =
          error instanceof SelectionQuickActionError
            ? error.code === "permissionDenied"
              ? "permissionDenied"
              : error.code === "invalidResult"
                ? "invalidResult"
                : "stale"
            : "failed"
        await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_ACTION_RESULT_EVENT, {
          ...request,
          ok: false,
          error: code,
        })
      }
    }

    const beginSpeaking = (candidate: ExternalSelectionCandidate) => {
      stopWatching?.()
      stopWatching = watchSelectionSpeech(candidate.id, (update) => {
        void emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_SPEECH_EVENT, {
          candidateId: candidate.id,
          playing: update.playing,
          progress: update.progress,
        })
        if (!update.playing) {
          stopWatching?.()
          stopWatching = null
        }
      })
      void speakSelection({ candidateId: candidate.id, text: candidate.text }).catch(() => {
        void emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_SPEECH_EVENT, {
          candidateId: candidate.id,
          playing: false,
        })
      })
    }

    const stageIntoComposer = async (payload: SelectionStagePayload) => {
      const { candidate, action } = payload
      const current = useChatStore.getState().activeSessionId
      const sessionId = current ?? (await startNewSession()).id
      if (!alive) return

      const chat = useChatStore.getState()
      const alreadyStaged = chat.contextSelections.some(
        (selection) => selection.kind === "external" && selection.candidateId === candidate.id
      )
      if (!alreadyStaged) {
        const selection: ExternalSelectionRef = {
          kind: "external",
          candidateId: candidate.id,
          title: candidate.sourceTitle ?? candidate.sourceApp,
          snapshot: candidate.text,
          comment: "",
          sourceApp: candidate.sourceApp,
          sourceTitle: candidate.sourceTitle,
          sourceUrl: candidate.sourceUrl,
          capturedAt: candidate.capturedAt,
          origin: candidate.origin,
          truncated: candidate.truncated,
        }
        chat.addContextSelection(selection)
      }

      useComposerIntentStore.getState().stage(sessionId, {
        candidateId: candidate.id,
        prompt: promptForAction(action, candidate, localeRef.current, tRef.current),
      })
      router.push("/")
    }

    const openGeneratedResult = async (payload: SelectionOpenResultPayload) => {
      const candidate = await getCurrentSelectionCandidate()
      if (!alive || !candidate || candidate.id !== payload.candidateId) return
      const current = useChatStore.getState().activeSessionId
      const sessionId = current ?? (await startNewSession()).id
      if (!alive) return
      const resultCandidateId = `${candidate.id}:result`
      const chat = useChatStore.getState()
      if (
        !chat.contextSelections.some(
          (selection) =>
            selection.kind === "external" && selection.candidateId === resultCandidateId
        )
      ) {
        chat.addContextSelection({
          kind: "external",
          candidateId: resultCandidateId,
          title: payload.attribution,
          snapshot: payload.text,
          comment: "",
          sourceApp: payload.attribution,
          sourceTitle: candidate.sourceTitle,
          sourceUrl: candidate.sourceUrl,
          capturedAt: Date.now(),
          origin: candidate.origin,
          truncated: false,
        })
      }
      useComposerIntentStore.getState().stage(sessionId, {
        candidateId: resultCandidateId,
        prompt: null,
      })
      router.push("/")
    }

    const consumePendingStage = async () => {
      const payload = await takePendingSelectionStage()
      if (!alive || !payload) return
      switch (payload.action.kind) {
        case "remember":
          await rememberSelection(payload.candidate)
          return
        case "speak":
          beginSpeaking(payload.candidate)
          return
        default:
          await stageIntoComposer(payload)
      }
    }

    void Promise.all([
      listen<ExternalSelectionCandidate>(SELECTION_CANDIDATE_EVENT, (event) => {
        if (alive) void publishPluginCatalog(event.payload)
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
      listen<SelectionActionRequestPayload>(SELECTION_ACTION_REQUEST_EVENT, (event) => {
        if (alive) void executePluginAction(event.payload)
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
      listen<SelectionOpenResultPayload>(SELECTION_OPEN_RESULT_EVENT, (event) => {
        if (alive) void openGeneratedResult(event.payload)
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
      listen(SELECTION_STAGE_EVENT, () => {
        if (alive) void consumePendingStage()
      }).then((dispose) => {
        if (!alive) {
          safeUnlisten(dispose)
          return
        }
        unlistens.push(dispose)
        // Drain anything staged while this window was still booting.
        void consumePendingStage()
      }),
      listen<{ candidateId: string }>(SELECTION_SPEECH_STOP_EVENT, (event) => {
        if (alive) stopSelectionSpeech(event.payload.candidateId)
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
    ])
    const unsubscribeCatalog = subscribeQuickActions(() => {
      if (alive) void publishPluginCatalog()
    })
    void publishPluginCatalog()

    return () => {
      alive = false
      stopWatching?.()
      unsubscribeCatalog()
      unlistens.forEach(safeUnlisten)
    }
  }, [router])

  return null
}

export default SelectionToolbarInitializer
