"use client"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { MicIcon, SquareIcon } from "lucide-react"
import type { ComponentProps } from "react"
import { useCallback, useEffect, useRef, useState } from "react"

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition
    webkitSpeechRecognition: new () => SpeechRecognition
  }
}

type SpeechInputMode = "speech-recognition" | "media-recorder" | "none"

export type SpeechInputProps = Omit<ComponentProps<typeof Button>, "onError"> & {
  onTranscriptionChange?: (text: string) => void
  /**
   * Callback for when audio is recorded using MediaRecorder fallback.
   * This is called in browsers that don't support the Web Speech API (Firefox, Safari).
   * The callback receives an audio Blob that should be sent to a transcription service.
   * Return the transcribed text, which will be passed to onTranscriptionChange.
   */
  onAudioRecorded?: (audioBlob: Blob) => Promise<string>
  /** Fires whenever recording starts/stops so consumers can surface state. */
  onListeningChange?: (listening: boolean) => void
  /**
   * Fires with the SpeechRecognition error code ("not-allowed", "no-speech",
   * "audio-capture", …) or the getUserMedia DOMException name, so consumers
   * can show a localized message.
   */
  onError?: (error: string) => void
  lang?: string
}

const detectSpeechInputMode = (): SpeechInputMode => {
  if (typeof window === "undefined") {
    return "none"
  }

  if ("SpeechRecognition" in window || "webkitSpeechRecognition" in window) {
    return "speech-recognition"
  }

  if ("MediaRecorder" in window && "mediaDevices" in navigator) {
    return "media-recorder"
  }

  return "none"
}

export const SpeechInput = ({
  className,
  onTranscriptionChange,
  onAudioRecorded,
  onListeningChange,
  onError,
  lang = "en-US",
  ...props
}: SpeechInputProps) => {
  const [isListening, setIsListeningState] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [mode] = useState<SpeechInputMode>(detectSpeechInputMode)
  const [isRecognitionReady, setIsRecognitionReady] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const onTranscriptionChangeRef =
    useRef<SpeechInputProps["onTranscriptionChange"]>(onTranscriptionChange)
  const onAudioRecordedRef = useRef<SpeechInputProps["onAudioRecorded"]>(onAudioRecorded)
  const onListeningChangeRef = useRef<SpeechInputProps["onListeningChange"]>(onListeningChange)
  const onErrorRef = useRef<SpeechInputProps["onError"]>(onError)
  const isListeningRef = useRef(false)

  // Keep refs in sync
  onTranscriptionChangeRef.current = onTranscriptionChange
  onAudioRecordedRef.current = onAudioRecorded
  onListeningChangeRef.current = onListeningChange
  onErrorRef.current = onError

  const setIsListening = useCallback((next: boolean) => {
    setIsListeningState(next)
    if (isListeningRef.current !== next) {
      isListeningRef.current = next
      onListeningChangeRef.current?.(next)
    }
  }, [])

  // Initialize Speech Recognition when mode is speech-recognition
  useEffect(() => {
    if (mode !== "speech-recognition") {
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const speechRecognition = new SpeechRecognition()

    speechRecognition.continuous = true
    speechRecognition.interimResults = true
    speechRecognition.lang = lang

    const handleStart = () => {
      setIsListening(true)
    }

    const handleEnd = () => {
      setIsListening(false)
    }

    const handleResult = (event: Event) => {
      const speechEvent = event as SpeechRecognitionEvent
      let finalTranscript = ""

      for (let i = speechEvent.resultIndex; i < speechEvent.results.length; i += 1) {
        const result = speechEvent.results[i]
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? ""
        }
      }

      if (finalTranscript) {
        onTranscriptionChangeRef.current?.(finalTranscript)
      }
    }

    const handleError = (event: Event) => {
      setIsListening(false)
      const errorCode = (event as SpeechRecognitionErrorEvent).error
      // "aborted" is the normal outcome of stop()/unmount — not an error.
      if (errorCode && errorCode !== "aborted") {
        onErrorRef.current?.(errorCode)
      }
    }

    speechRecognition.addEventListener("start", handleStart)
    speechRecognition.addEventListener("end", handleEnd)
    speechRecognition.addEventListener("result", handleResult)
    speechRecognition.addEventListener("error", handleError)

    recognitionRef.current = speechRecognition
    setIsRecognitionReady(true)

    return () => {
      speechRecognition.removeEventListener("start", handleStart)
      speechRecognition.removeEventListener("end", handleEnd)
      speechRecognition.removeEventListener("result", handleResult)
      speechRecognition.removeEventListener("error", handleError)
      speechRecognition.stop()
      recognitionRef.current = null
      setIsRecognitionReady(false)
    }
  }, [mode, lang, setIsListening])

  // Cleanup MediaRecorder and stream on unmount
  useEffect(
    () => () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop()
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop()
        }
      }
    },
    []
  )

  // Start MediaRecorder recording
  const startMediaRecorder = useCallback(async () => {
    if (!onAudioRecordedRef.current) {
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mediaRecorder = new MediaRecorder(stream)
      audioChunksRef.current = []

      const handleDataAvailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      const handleStop = async () => {
        for (const track of stream.getTracks()) {
          track.stop()
        }
        streamRef.current = null

        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        })

        if (audioBlob.size > 0 && onAudioRecordedRef.current) {
          setIsProcessing(true)
          try {
            const transcript = await onAudioRecordedRef.current(audioBlob)
            if (transcript) {
              onTranscriptionChangeRef.current?.(transcript)
            }
          } catch {
            // Error handling delegated to the onAudioRecorded caller
          } finally {
            setIsProcessing(false)
          }
        }
      }

      const handleError = () => {
        setIsListening(false)
        for (const track of stream.getTracks()) {
          track.stop()
        }
        streamRef.current = null
        onErrorRef.current?.("audio-capture")
      }

      mediaRecorder.addEventListener("dataavailable", handleDataAvailable)
      mediaRecorder.addEventListener("stop", handleStop)
      mediaRecorder.addEventListener("error", handleError)

      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start()
      setIsListening(true)
    } catch (caughtError) {
      setIsListening(false)
      const name = caughtError instanceof Error ? caughtError.name : ""
      onErrorRef.current?.(
        name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : "audio-capture"
      )
    }
  }, [setIsListening])

  // Stop MediaRecorder recording
  const stopMediaRecorder = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop()
    }
    setIsListening(false)
  }, [setIsListening])

  const toggleListening = useCallback(() => {
    if (mode === "speech-recognition" && recognitionRef.current) {
      if (isListening) {
        recognitionRef.current.stop()
      } else {
        recognitionRef.current.start()
      }
    } else if (mode === "media-recorder") {
      if (isListening) {
        stopMediaRecorder()
      } else {
        startMediaRecorder()
      }
    }
  }, [mode, isListening, startMediaRecorder, stopMediaRecorder])

  // Determine if button should be disabled
  const isDisabled =
    mode === "none" ||
    (mode === "speech-recognition" && !isRecognitionReady) ||
    (mode === "media-recorder" && !onAudioRecorded) ||
    isProcessing

  return (
    <div className="relative inline-flex items-center justify-center">
      {/* Animated pulse rings */}
      {isListening &&
        [0, 1, 2].map((index) => (
          <div
            className="absolute inset-0 animate-ping rounded-full border-2 border-red-400/30"
            key={index}
            style={{
              animationDelay: `${index * 0.3}s`,
              animationDuration: "2s",
            }}
          />
        ))}

      {/* Main record button */}
      <Button
        className={cn(
          "relative z-10 rounded-full transition-all duration-300",
          isListening
            ? "bg-destructive text-white hover:bg-destructive/80 hover:text-white"
            : "bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground",
          className
        )}
        data-listening={isListening || undefined}
        disabled={isDisabled}
        onClick={toggleListening}
        {...props}
      >
        {isProcessing && <Spinner />}
        {!isProcessing && isListening && <SquareIcon className="size-4" />}
        {!(isProcessing || isListening) && <MicIcon className="size-4" />}
      </Button>
    </div>
  )
}
