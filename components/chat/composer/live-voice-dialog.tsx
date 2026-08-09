"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AudioWaveformIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react"
import { toast } from "sonner"
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
import { useLiveVoiceState } from "@/hooks/voice/use-live-voice"
import { createLiveVoiceController, type LiveVoiceController } from "@/lib/voice/live/controller"
import {
  LiveVoiceUnavailableError,
  resolveLiveVoiceSession,
  type LiveVoiceUnavailableReason,
} from "@/lib/voice/live/session"
import { buildLiveVoiceRuntimeBindings } from "@/lib/voice/live/runtime-bindings"
import { persistLiveVoiceTurns, type LiveVoiceTurnProvenance } from "@/lib/voice/live/persist-turns"
import { screenLiveVoiceText } from "@/lib/voice/realtime-session"
import { DEFAULT_LIVE_VOICE_SETTINGS } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
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
type StartFailure = LiveVoiceUnavailableReason | "mintFailed"

const UNAVAILABLE_MESSAGE_KEYS: Record<StartFailure, string> = {
  disabled: "errors.disabled",
  "no-deployments": "errors.noDeployments",
  "none-eligible": "errors.noneEligible",
  mintFailed: "errors.mintFailed",
}

const PERSONA_STATE_BY_PHASE: Record<LiveVoiceState["phase"], PersonaState> = {
  idle: "asleep",
  connecting: "thinking",
  listening: "listening",
  speaking: "listening",
  thinking: "thinking",
  responding: "speaking",
  error: "asleep",
}

export function LiveVoiceDialog({ disabled, onUserTranscript }: LiveVoiceDialogProps) {
  const t = useTranslations("chat.composer.voice.live")
  const settings = useSettingsStore((store) => store.settings)
  const providerKeys = useSettingsStore((store) => store.providerKeys)
  const sessionId = useChatStore((store) => store.activeSessionId)
  const [open, setOpen] = useState(false)
  const [controller, setController] = useState<LiveVoiceController | null>(null)
  const [startFailure, setStartFailure] = useState<StartFailure | null>(null)
  const [personaFailed, setPersonaFailed] = useState(false)
  const controllerRef = useRef<LiveVoiceController | null>(null)
  const deliveredTurns = useRef(new Set<string>())
  /** Provenance + wall clock captured at start, so teardown can persist turns. */
  const sessionMetaRef = useRef<{
    sessionId: string
    startedAt: number
    provenance: LiveVoiceTurnProvenance
  } | null>(null)

  const state = useLiveVoiceState(controller)

  // Read out before the callback closes over them: depending on
  // `settings?.liveVoice` inside the callback makes the React Compiler infer
  // the whole `settings` object as the dependency, which it then refuses to
  // memoize because that is broader than the declared list.
  const liveVoiceSettings = settings?.liveVoice
  const microphoneId = settings?.selectedMicId
  const agentPermissions = settings?.agentPermissions
  const alwaysAllowTools = settings?.alwaysAllowTools

  // Only the providers with a shipped adapter can consume a BYOK key; the
  // relay-backed ones read their credentials in the host.
  const apiKeys = useMemo(
    () => ({
      openai: providerKeys?.openai,
      google: providerKeys?.google,
      xai: providerKeys?.xai,
    }),
    [providerKeys?.openai, providerKeys?.google, providerKeys?.xai]
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
  }, [state.turns, onUserTranscript])

  const endSession = useCallback(() => {
    const active = controllerRef.current
    const meta = sessionMetaRef.current
    controllerRef.current = null
    sessionMetaRef.current = null

    // Read the transcript before stopping — `stop()` resets the state, so the
    // turns are gone by the time the promise settles.
    const turns = active?.getSnapshot().turns ?? []
    void active?.stop()

    if (meta && turns.length > 0) {
      void persistLiveVoiceTurns({
        sessionId: meta.sessionId,
        turns,
        provenance: meta.provenance,
        startedAt: meta.startedAt,
      }).catch(() => {
        // The conversation still happened; failing to archive it must not take
        // the composer down with it.
      })
    }

    setController(null)
    deliveredTurns.current.clear()
    setStartFailure(null)
    setOpen(false)
  }, [])

  useEffect(() => () => void controllerRef.current?.stop(), [])

  const startSession = useCallback(async () => {
    if (disabled || controllerRef.current) return
    setOpen(true)
    setStartFailure(null)
    setPersonaFailed(false)

    let next: LiveVoiceController | null = null
    try {
      const resolved = await resolveLiveVoiceSession({
        settings: liveVoiceSettings,
        instructions: liveVoiceSettings?.instructions,
        apiKeys,
      })

      // Tools, permissions and the conversation seed, resolved once. A failure
      // in here degrades the session rather than blocking it.
      const bindings = await buildLiveVoiceRuntimeBindings({
        sessionId: sessionId ?? undefined,
        capabilities: resolved.session.capabilities,
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

      next = createLiveVoiceController({
        session: resolved.session,
        adapter: resolved.adapter,
        instructions: resolved.instructions,
        voice: resolved.voice,
        deviceId: microphoneId,
        tools: bindings.tools,
        toolExecution: bindings.toolExecution,
        contextTranscript: bindings.contextTranscript,
      })
      controllerRef.current = next
      if (sessionId) {
        sessionMetaRef.current = {
          sessionId,
          startedAt: Date.now(),
          provenance: {
            provider: resolved.session.provider,
            modelOrResource: resolved.session.modelOrResource,
            region: resolved.session.region,
          },
        }
      }
      setController(next)
      await next.start()
    } catch (error) {
      // Drop a half-built controller: leaving it in the ref would make the next
      // click a no-op with the dialog stuck on an error.
      if (controllerRef.current === next) {
        controllerRef.current = null
        void next?.stop()
        setController(null)
      }
      const failure: StartFailure =
        error instanceof LiveVoiceUnavailableError ? error.reason : "mintFailed"
      setStartFailure(failure)
      toast.error(t(UNAVAILABLE_MESSAGE_KEYS[failure]))
    }
  }, [
    disabled,
    liveVoiceSettings,
    microphoneId,
    apiKeys,
    sessionId,
    agentPermissions,
    alwaysAllowTools,
    t,
  ])

  const toggleMute = useCallback(() => {
    controllerRef.current?.setMuted(!state.muted)
  }, [state.muted])

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) endSession()
      else setOpen(true)
    },
    [endSession]
  )

  const phase = startFailure ? "error" : state.phase

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t("startLive")}
            className="size-8 shrink-0"
            disabled={disabled}
            onClick={() => void startSession()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <AudioWaveformIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("startLive")}</TooltipContent>
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
              {(startFailure || state.error) && (
                <p role="alert" className="text-center text-xs text-destructive">
                  {startFailure
                    ? t(UNAVAILABLE_MESSAGE_KEYS[startFailure])
                    : t("errors.sessionFailed")}
                </p>
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

            <div className="flex items-center justify-center gap-4 border-t p-4">
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
