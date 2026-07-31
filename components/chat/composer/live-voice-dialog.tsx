"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AudioWaveformIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react"
import { toast } from "sonner"
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
import {
  createInitialLiveVoiceState,
  RealtimeVoiceSession,
  screenLiveVoiceText,
  type LiveVoiceState,
} from "@/lib/voice/realtime-session"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"

interface LiveVoiceDialogProps {
  disabled?: boolean
  onUserTranscript?: (text: string) => void
}

export function LiveVoiceDialog({ disabled, onUserTranscript }: LiveVoiceDialogProps) {
  const t = useTranslations("chat.composer.voice.live")
  const settings = useSettingsStore((store) => store.settings)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LiveVoiceState>(createInitialLiveVoiceState)
  const sessionRef = useRef<RealtimeVoiceSession | null>(null)
  const deliveredTurns = useRef(new Set<string>())

  const receiveState = useCallback(
    (next: LiveVoiceState) => {
      setState(next)
      for (const turn of next.turns) {
        if (turn.role !== "user" || deliveredTurns.current.has(turn.id)) continue
        deliveredTurns.current.add(turn.id)
        const safeText = screenLiveVoiceText(turn.text)
        if (safeText) onUserTranscript?.(safeText)
      }
    },
    [onUserTranscript]
  )

  const endSession = useCallback(() => {
    sessionRef.current?.stop()
    sessionRef.current = null
    deliveredTurns.current.clear()
    setOpen(false)
    setState(createInitialLiveVoiceState())
  }, [])

  useEffect(() => () => sessionRef.current?.stop(), [])

  const startSession = useCallback(async () => {
    if (disabled || sessionRef.current) return
    setOpen(true)
    const session = new RealtimeVoiceSession(receiveState)
    sessionRef.current = session
    try {
      await session.start({
        model: settings?.realtimeModel ?? "gpt-realtime-2.1",
        voice: settings?.realtimeVoice ?? "marin",
        instructions: settings?.realtimeInstructions ?? "",
        microphoneId: settings?.selectedMicId,
      })
    } catch {
      toast.error(t("errors.startFailed"))
    }
  }, [disabled, receiveState, settings, t])

  const toggleMute = useCallback(() => {
    const muted = !state.muted
    sessionRef.current?.setMuted(muted)
  }, [state.muted])

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) endSession()
      else setOpen(true)
    },
    [endSession]
  )

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
              <div
                className={cn(
                  "relative flex size-24 items-center justify-center rounded-full bg-primary/10 text-primary",
                  state.phase === "speaking" && "animate-pulse bg-destructive/10 text-destructive",
                  state.phase === "responding" && "bg-emerald-500/10 text-emerald-600"
                )}
              >
                <AudioWaveformIcon className="size-11" />
                {(state.phase === "speaking" || state.phase === "responding") && (
                  <span className="absolute inset-0 animate-ping rounded-full border border-current opacity-30" />
                )}
              </div>
              <p aria-live="polite" className="text-sm font-medium">
                {t(`phases.${state.phase}`)}
              </p>
              {state.error && (
                <p role="alert" className="text-center text-xs text-destructive">
                  {t("errors.sessionFailed")}
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
