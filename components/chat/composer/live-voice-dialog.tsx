"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import {
  AudioLinesIcon,
  AudioWaveformIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  MicSelector,
  MicSelectorContent,
  MicSelectorEmpty,
  MicSelectorItem,
  MicSelectorLabel,
  MicSelectorList,
  MicSelectorTrigger,
  MicSelectorValue,
} from "@/components/ai-elements/mic-selector"
import { Persona, type PersonaState } from "@/components/ai-elements/persona"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLiveVoiceInputLevel, useLiveVoiceState } from "@/hooks/voice/use-live-voice"
import { createLiveVoiceController, type LiveVoiceController } from "@/lib/voice/live/controller"
import { preflightMicrophone, type MediaStreamLike } from "@/lib/voice/live/capture"
import {
  LiveVoiceUnavailableError,
  explainLiveVoiceUnavailability,
  resolveLiveVoiceSession,
  selectLiveVoiceCandidates,
  type LiveVoiceUnavailableReason,
} from "@/lib/voice/live/session"
import { buildLiveVoiceRuntimeBindings } from "@/lib/voice/live/runtime-bindings"
import {
  createLiveVoiceTurnPersister,
  persistLiveVoiceTurns,
  type LiveVoiceTurnPersister,
  type LiveVoiceTurnProvenance,
} from "@/lib/voice/live/persist-turns"
import {
  classifyLiveVoiceError,
  screenLiveVoiceText,
  type LiveVoiceErrorCode,
  type LiveVoiceErrorInfo,
} from "@/lib/voice/live/reducer"
import { DEFAULT_LIVE_VOICE_SETTINGS } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import { cn } from "@/lib/utils"
import type { LiveVoiceState } from "@/lib/voice/live/reducer"

interface LiveVoiceDialogProps {
  disabled?: boolean
  onUserTranscript?: (text: string) => void
}

/**
 * Which message explains a failed start.
 *
 * Kept as a translation-key suffix rather than a sentence so the four
 * "nothing to dial" situations stay distinguishable — "no provider configured"
 * and "your key was rejected" need very different next actions from the user.
 */
type StartFailure = LiveVoiceUnavailableReason

const UNAVAILABLE_MESSAGE_KEYS: Record<StartFailure, string> = {
  disabled: "errors.disabled",
  "no-deployments": "errors.noDeployments",
  "none-eligible": "errors.noneEligible",
}

const PERSONA_STATE_BY_PHASE: Record<LiveVoiceState["phase"], PersonaState> = {
  idle: "asleep",
  connecting: "thinking",
  reconnecting: "thinking",
  listening: "listening",
  speaking: "listening",
  thinking: "thinking",
  responding: "speaking",
  error: "asleep",
}

const ERROR_MESSAGE_KEYS: Record<LiveVoiceErrorCode, string> = {
  "device-permission": "errors.codes.devicePermission",
  "device-unavailable": "errors.codes.deviceUnavailable",
  authentication: "errors.codes.authentication",
  "rate-limit": "errors.codes.rateLimit",
  "connection-timeout": "errors.codes.connectionTimeout",
  network: "errors.codes.network",
  "session-expired": "errors.codes.sessionExpired",
  "provider-error": "errors.codes.provider",
}

const LIVE_VOICE_START_CANCELLED = Symbol("live-voice-start-cancelled")

export function LiveVoiceDialog({ disabled, onUserTranscript }: LiveVoiceDialogProps) {
  const t = useTranslations("chat.composer.voice.live")
  const settings = useSettingsStore((store) => store.settings)
  const providerKeys = useSettingsStore((store) => store.providerKeys)
  const ensureProviderKeys = useSettingsStore((store) => store.ensureProviderKeys)
  const saveSettings = useSettingsStore((store) => store.save)
  const sessionId = useChatStore((store) => store.activeSessionId)
  const chatStatus = useChatStore((store) => store.status)
  const [open, setOpen] = useState(false)
  const [controller, setController] = useState<LiveVoiceController | null>(null)
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null)
  const [startError, setStartError] = useState<LiveVoiceErrorInfo | null>(null)
  const [microphoneReady, setMicrophoneReady] = useState(false)
  const [activeMicId, setActiveMicId] = useState<string | undefined>(settings?.selectedMicId)
  const [prevSelectedMicId, setPrevSelectedMicId] = useState<string | undefined>(
    settings?.selectedMicId
  )
  const [personaFailed, setPersonaFailed] = useState(false)
  const controllerRef = useRef<LiveVoiceController | null>(null)
  const deliveredTurns = useRef(new Set<string>())
  const persisterRef = useRef<LiveVoiceTurnPersister | null>(null)
  const switchingMicRef = useRef(false)
  const lastMicSelectionRef = useRef<string | undefined | null>(null)
  const failedMicIdRef = useRef<string | undefined | null>(null)
  const startGenerationRef = useRef(0)
  const startingRef = useRef(false)
  /** Provenance + wall clock captured at start, so teardown can persist turns. */
  const sessionMetaRef = useRef<{
    sessionId: string
    startedAt: number
    provenance: LiveVoiceTurnProvenance
  } | null>(null)

  const state = useLiveVoiceState(controller)
  const inputLevel = useLiveVoiceInputLevel(controller)

  // Read out before the callback closes over them: depending on
  // `settings?.liveVoice` inside the callback makes the React Compiler infer
  // the whole `settings` object as the dependency, which it then refuses to
  // memoize because that is broader than the declared list.
  const liveVoiceSettings = settings?.liveVoice
  const microphoneId = settings?.selectedMicId
  const agentPermissions = settings?.agentPermissions
  const alwaysAllowTools = settings?.alwaysAllowTools

  // Keep the optimistic local selector aligned with settings changed by
  // another mounted control or window. React recommends adjusting derived
  // state during render instead of a synchronous setState effect.
  if (prevSelectedMicId !== microphoneId) {
    setPrevSelectedMicId(microphoneId)
    setActiveMicId(microphoneId)
  }

  // Browser providers consume their BYOK values while native providers only
  // use the in-memory keyring-presence marker for configuration gating.
  const apiKeys = useMemo(
    () => ({
      openai: providerKeys?.openai,
      google: providerKeys?.google,
      xai: providerKeys?.xai,
    }),
    [providerKeys?.openai, providerKeys?.google, providerKeys?.xai]
  )

  useEffect(() => {
    void ensureProviderKeys()
  }, [ensureProviderKeys])

  const liveVoiceCandidates = useMemo(
    () => selectLiveVoiceCandidates(liveVoiceSettings),
    [liveVoiceSettings]
  )
  const configuredCandidates = useMemo(
    () =>
      liveVoiceCandidates.filter(({ deployment }) =>
        Boolean(providerKeys?.[deployment.provider]?.trim())
      ),
    [liveVoiceCandidates, providerKeys]
  )
  const unavailableReason =
    liveVoiceSettings?.enabled && configuredCandidates.length === 0
      ? explainLiveVoiceUnavailability(liveVoiceSettings)
      : null
  const chatBusy = chatStatus === "streaming" || chatStatus === "awaiting_approval"
  const triggerDisabled = Boolean(disabled || chatBusy || unavailableReason)

  const upsertPersistedMessages = useCallback(
    (messages: readonly UIMessage[]) => {
      if (sessionId && messages.length > 0) {
        useChatStore.getState().upsertSessionMessages(sessionId, messages)
      }
    },
    [sessionId]
  )

  // Deliver each finalised user turn to the composer exactly once. Screened
  // again here because the transcript is model output, not the instructions
  // that were gated at mint time.
  useEffect(() => {
    for (const turn of state.turns) {
      if (turn.role !== "user" || deliveredTurns.current.has(turn.id)) continue
      deliveredTurns.current.add(turn.id)
      const safeText = screenLiveVoiceText(turn.text)
      if (safeText) onUserTranscript?.(safeText)
    }
    void persisterRef.current
      ?.append(state.turns, controller?.getToolRecords() ?? [])
      .catch(() => undefined)
  }, [state.turns, onUserTranscript, controller])

  const endSession = useCallback(() => {
    startGenerationRef.current++
    startingRef.current = false
    const active = controllerRef.current
    const meta = sessionMetaRef.current
    const persister = persisterRef.current
    controllerRef.current = null
    sessionMetaRef.current = null
    persisterRef.current = null

    // Read the transcript before stopping — `stop()` resets the state, so the
    // turns are gone by the time the promise settles.
    const turns = active?.getSnapshot().turns ?? []
    const toolRecords = active?.getToolRecords() ?? []
    void active?.stop()

    if (persister) {
      void persister.flush(turns, toolRecords).catch(() => {
        // The conversation still happened; failing to archive it must not take
        // the composer down with it.
      })
    } else if (meta && (turns.length > 0 || toolRecords.length > 0)) {
      void persistLiveVoiceTurns({
        sessionId: meta.sessionId,
        turns,
        provenance: meta.provenance,
        startedAt: meta.startedAt,
        toolRecords,
      })
        .then((messages) => {
          useChatStore.getState().upsertSessionMessages(meta.sessionId, messages)
        })
        .catch(() => {
          // The conversation still happened; failing to archive it must not take
          // the composer down with it.
        })
    }

    setController(null)
    setMicrophoneReady(false)
    deliveredTurns.current.clear()
    setStartFailure(null)
    setStartError(null)
    setOpen(false)
  }, [])

  useEffect(
    () => () => {
      startGenerationRef.current++
      startingRef.current = false
      void controllerRef.current?.stop()
    },
    []
  )

  const startSession = useCallback(async () => {
    if (triggerDisabled || controllerRef.current || startingRef.current) return
    const generation = ++startGenerationRef.current
    const assertStartActive = () => {
      if (generation !== startGenerationRef.current) throw LIVE_VOICE_START_CANCELLED
    }
    startingRef.current = true
    setOpen(true)
    setMicrophoneReady(false)
    setStartFailure(null)
    setStartError(null)
    setPersonaFailed(false)

    let next: LiveVoiceController | null = null
    let preflightStream: MediaStreamLike | null = null
    try {
      const candidates = configuredCandidates
      if (candidates.length === 0) {
        throw new LiveVoiceUnavailableError(explainLiveVoiceUnavailability(liveVoiceSettings))
      }

      // Live conversation owns audio focus from this point forward. Existing
      // speech is intentionally not resumed when the session ends.
      ttsOrchestrator.stop()

      // Permission is settled before minting an ephemeral token. The retained
      // stream is handed to the capture graph after provider readiness.
      preflightStream = await preflightMicrophone(microphoneId)
      assertStartActive()

      // Tools, permissions and the conversation seed, resolved once. A failure
      // in here degrades the session rather than blocking it.
      const bindings = await buildLiveVoiceRuntimeBindings({
        sessionId: sessionId ?? undefined,
        capabilities: candidates[0].capabilities,
        policy: {
          toolRules: agentPermissions?.toolRules,
          alwaysAllowTools,
        },
        limits: {
          turnLimit:
            liveVoiceSettings?.historyTurnLimit ?? DEFAULT_LIVE_VOICE_SETTINGS.historyTurnLimit,
          characterLimit:
            liveVoiceSettings?.historyCharacterLimit ??
            DEFAULT_LIVE_VOICE_SETTINGS.historyCharacterLimit,
        },
      })
      assertStartActive()

      let resolved: Awaited<ReturnType<typeof resolveLiveVoiceSession>> | null = null
      let lastError: unknown
      let connectedStartedAt = Date.now()
      for (const [candidateIndex, candidate] of candidates.entries()) {
        let microphoneOpened = false
        const lockedSettings = liveVoiceSettings
          ? {
              ...liveVoiceSettings,
              fallbackEnabled: false,
              preferredDeploymentId: candidate.deployment.id,
              deployments: [candidate.deployment],
            }
          : liveVoiceSettings
        try {
          resolved = await resolveLiveVoiceSession({
            settings: lockedSettings,
            instructions: liveVoiceSettings?.instructions,
            tools: bindings.tools,
            apiKeys,
          })
          assertStartActive()
          const initial = resolved
          connectedStartedAt = Date.now()
          const candidatePersister = sessionId
            ? createLiveVoiceTurnPersister({
                sessionId,
                provenance: {
                  provider: initial.session.provider,
                  modelOrResource: initial.session.modelOrResource,
                  region: initial.session.region,
                },
                startedAt: connectedStartedAt,
                onPersisted: upsertPersistedMessages,
              })
            : null
          next = createLiveVoiceController({
            session: initial.session,
            adapter: initial.adapter,
            sessionConfig: initial.sessionConfig,
            deviceId: microphoneId,
            initialStream: preflightStream,
            connectTimeoutMs:
              liveVoiceSettings?.connectTimeoutMs ?? DEFAULT_LIVE_VOICE_SETTINGS.connectTimeoutMs,
            tools: bindings.tools,
            toolExecution: bindings.toolExecution,
            contextTranscript: bindings.contextTranscript,
            onToolRecord: () => {
              void candidatePersister
                ?.append(next?.getSnapshot().turns ?? [], next?.getToolRecords() ?? [])
                .catch(() => undefined)
            },
            reconnectSession: async ({ resumptionHandle }) => {
              const refreshed = await resolveLiveVoiceSession({
                settings: lockedSettings,
                instructions: liveVoiceSettings?.instructions,
                tools: bindings.tools,
                apiKeys,
                resumptionHandle,
              })
              return {
                session: refreshed.session,
                adapter: refreshed.adapter,
                sessionConfig: refreshed.sessionConfig,
              }
            },
          })
          assertStartActive()
          controllerRef.current = next
          persisterRef.current = candidatePersister
          setController(next)
          await next.start()
          assertStartActive()
          await next.waitUntilReady()
          assertStartActive()
          microphoneOpened = true
          setMicrophoneReady(true)
          await next.waitUntilFirstAudioFrame()
          assertStartActive()
          break
        } catch (error) {
          if (generation !== startGenerationRef.current) throw LIVE_VOICE_START_CANCELLED
          lastError = error
          const errorInfo = classifyLiveVoiceError(
            error instanceof Error ? error : new Error(String(error))
          )
          if (controllerRef.current === next) controllerRef.current = null
          await next?.stop()
          persisterRef.current = null
          next = null
          resolved = null
          setMicrophoneReady(false)
          if (microphoneOpened && candidateIndex < candidates.length - 1) {
            // The previous capture graph owned (and stopped) the retained
            // stream. Re-preflight before minting the next candidate.
            preflightStream = await preflightMicrophone(microphoneId)
            assertStartActive()
          }
          if (errorInfo.code === "device-permission" || errorInfo.code === "device-unavailable") {
            throw error
          }
        }
      }
      if (!next || !resolved) throw lastError ?? new Error("No live voice provider connected")

      if (sessionId) {
        sessionMetaRef.current = {
          sessionId,
          startedAt: connectedStartedAt,
          provenance: {
            provider: resolved.session.provider,
            modelOrResource: resolved.session.modelOrResource,
            region: resolved.session.region,
          },
        }
      }
    } catch (error) {
      const cancelled = error === LIVE_VOICE_START_CANCELLED
      // Drop a half-built controller: leaving it in the ref would make the next
      // click a no-op with the dialog stuck on an error.
      if (next && controllerRef.current === next) {
        controllerRef.current = null
        void next?.stop()
        if (!cancelled) setController(null)
      }
      for (const track of preflightStream?.getTracks() ?? []) track.stop()
      if (cancelled) return
      if (error instanceof LiveVoiceUnavailableError) {
        setStartFailure(error.reason)
        toast.error(t(UNAVAILABLE_MESSAGE_KEYS[error.reason]))
      } else {
        const errorInfo = classifyLiveVoiceError(
          error instanceof Error ? error : new Error(String(error))
        )
        setStartError(errorInfo)
        toast.error(t(ERROR_MESSAGE_KEYS[errorInfo.code]))
      }
    } finally {
      if (generation === startGenerationRef.current) startingRef.current = false
    }
  }, [
    triggerDisabled,
    liveVoiceSettings,
    microphoneId,
    apiKeys,
    configuredCandidates,
    sessionId,
    agentPermissions,
    alwaysAllowTools,
    t,
    upsertPersistedMessages,
  ])

  const toggleMute = useCallback(() => {
    controllerRef.current?.setMuted(!state.muted)
  }, [state.muted])

  const retrySession = useCallback(() => {
    setStartError(null)
    const active = controllerRef.current
    if (active) void active.retry()
    else void startSession()
  }, [startSession])

  const changeMicrophone = useCallback(
    async (next: string | undefined) => {
      const active = controllerRef.current
      if (!microphoneReady || !active || switchingMicRef.current || next === activeMicId) return
      switchingMicRef.current = true
      const previous = activeMicId
      let deviceChanged = false
      setActiveMicId(next)
      try {
        await active.setDevice(next)
        deviceChanged = true
        await saveSettings({ selectedMicId: next })
      } catch {
        failedMicIdRef.current = next
        let rolledBack = !deviceChanged
        if (deviceChanged) {
          try {
            await active.setDevice(previous)
            rolledBack = true
          } catch {
            // The previous device is no longer available. Keep the selector
            // honest about the capture that is still live.
          }
        }
        setActiveMicId(rolledBack ? previous : next)
        toast.error(t("errors.deviceSwitchFailed"))
      } finally {
        switchingMicRef.current = false
      }
    },
    [activeMicId, microphoneReady, saveSettings, t]
  )

  const selectMicrophone = useCallback(
    (next: string | undefined) => {
      if (failedMicIdRef.current === next) return
      if (lastMicSelectionRef.current === next) return
      lastMicSelectionRef.current = next
      setTimeout(() => {
        if (lastMicSelectionRef.current === next) lastMicSelectionRef.current = null
      }, 0)
      void changeMicrophone(next)
    },
    [changeMicrophone]
  )

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) endSession()
      else setOpen(true)
    },
    [endSession]
  )

  const phase = startFailure || startError ? "error" : state.phase

  if (!liveVoiceSettings?.enabled) return null

  const triggerHint = unavailableReason
    ? t(UNAVAILABLE_MESSAGE_KEYS[unavailableReason])
    : chatBusy
      ? t("busyHint")
      : t("startLive")

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t("startLive")}
            className="size-8 shrink-0"
            disabled={triggerDisabled}
            onClick={() => void startSession()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <AudioWaveformIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{triggerHint}</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle className="flex items-center gap-2">
              <AudioWaveformIcon className="size-5 text-primary" />
              {t("title")}
            </DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-72 flex-col">
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-8">
              {personaFailed ? (
                <div
                  className={cn(
                    "relative flex size-24 items-center justify-center rounded-full bg-primary/10 text-primary",
                    phase === "speaking" && "animate-pulse bg-destructive/10 text-destructive",
                    phase === "responding" && "bg-emerald-500/10 text-emerald-600"
                  )}
                  data-testid="live-voice-persona-fallback"
                >
                  <AudioWaveformIcon className="size-11" />
                  {(phase === "speaking" || phase === "responding") && (
                    <span className="absolute inset-0 animate-ping rounded-full border border-current opacity-30" />
                  )}
                </div>
              ) : (
                <Persona
                  className="size-24"
                  onLoadError={() => setPersonaFailed(true)}
                  state={PERSONA_STATE_BY_PHASE[phase]}
                  variant="obsidian"
                />
              )}
              <p aria-live="polite" className="text-sm font-medium">
                {t(`phases.${phase}`)}
              </p>
              {(startFailure || startError || state.errorInfo) && (
                <p role="alert" className="text-center text-xs text-destructive">
                  {startFailure
                    ? t(UNAVAILABLE_MESSAGE_KEYS[startFailure])
                    : t(ERROR_MESSAGE_KEYS[(startError ?? state.errorInfo)!.code])}
                </p>
              )}
              {state.phase === "reconnecting" && state.reconnect && (
                <p className="text-xs text-muted-foreground">
                  {t("reconnectProgress", state.reconnect)}
                </p>
              )}
              {controller && phase !== "connecting" && (
                <div className="flex w-full max-w-48 items-center gap-2">
                  <MicIcon className="size-3.5 text-muted-foreground" />
                  <div
                    aria-label={t("inputLevel")}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={Math.round(inputLevel * 100)}
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                    role="meter"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-100"
                      style={{ width: `${Math.round(inputLevel * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              {phase === "error" &&
                ((controller && state.errorInfo?.retryable) ||
                  (!controller && startError?.retryable)) && (
                  <Button onClick={retrySession} size="sm" type="button" variant="outline">
                    <RefreshCwIcon className="size-3.5" />
                    {t("retry")}
                  </Button>
                )}
            </div>

            {(state.turns.length > 0 || state.assistantDraft) && (
              <ScrollArea className="max-h-44 border-t">
                <div className="space-y-3 p-4">
                  {state.turns.map((turn) => (
                    <div
                      key={turn.id}
                      className={cn(
                        "rounded-lg px-3 py-2 text-sm",
                        turn.role === "user"
                          ? "ml-8 bg-primary text-primary-foreground"
                          : "mr-8 bg-muted"
                      )}
                    >
                      {turn.text}
                    </div>
                  ))}
                  {state.assistantDraft && (
                    <div className="mr-8 rounded-lg bg-muted px-3 py-2 text-sm">
                      {state.assistantDraft}
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}

            <div className="flex items-center justify-center gap-3 border-t p-4">
              <MicSelector
                onOpenChange={(isOpen) => {
                  if (isOpen) failedMicIdRef.current = null
                }}
                onValueChange={selectMicrophone}
                value={activeMicId}
              >
                <MicSelectorTrigger
                  aria-label={t("selectMicrophone")}
                  className="h-9 max-w-36 justify-between gap-2 px-3"
                  disabled={!microphoneReady}
                  size="sm"
                  variant="outline"
                >
                  <AudioLinesIcon className="size-3.5 shrink-0" />
                  <MicSelectorValue className="truncate" />
                </MicSelectorTrigger>
                <MicSelectorContent>
                  <MicSelectorList>
                    {(devices) =>
                      devices.length ? (
                        devices.map((device) => (
                          <MicSelectorItem key={device.deviceId} value={device.deviceId}>
                            <MicSelectorLabel device={device} />
                          </MicSelectorItem>
                        ))
                      ) : (
                        <MicSelectorEmpty>{t("noMicrophone")}</MicSelectorEmpty>
                      )
                    }
                  </MicSelectorList>
                </MicSelectorContent>
              </MicSelector>
              <Button
                aria-label={state.muted ? t("unmute") : t("mute")}
                disabled={!controller}
                onClick={toggleMute}
                size="icon"
                type="button"
                variant="secondary"
              >
                {state.muted ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
              </Button>
              <Button
                aria-label={t("end")}
                className="rounded-full"
                onClick={endSession}
                size="icon"
                type="button"
                variant="destructive"
              >
                <PhoneOffIcon className="size-4" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
