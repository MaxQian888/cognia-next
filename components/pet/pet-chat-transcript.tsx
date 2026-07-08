// Presentational scrollable transcript for the pet chat panel. Renders the
// durable `petConversation` turns (user + pet) plus an optimistic `pending`
// user message while a reply is in flight, and a reason banner when the last
// turn degraded (the bubble path fails silently — here we say why). Pure
// presentation: all data comes from `usePetChat`.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { PetConversationRow } from "@/types/pet"
import type { PetChatDegradeReason } from "@/lib/pet/chat/respond"

export interface PetChatTranscriptProps {
  turns: PetConversationRow[]
  /** In-flight (or last-degraded) user text, shown optimistically. */
  pending: string | null
  inFlight: boolean
  degradeReason: PetChatDegradeReason | null
  /** Display name for the pet's turns (falls back to a generic label). */
  petName?: string | null
  className?: string
}

function Bubble({ who, text, mine }: { who: string; text: string; mine: boolean }) {
  return (
    <div className={cn("flex flex-col gap-0.5", mine ? "items-end" : "items-start")}>
      <span className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{who}</span>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
          mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        )}
      >
        {text}
      </div>
    </div>
  )
}

export function PetChatTranscript({
  turns,
  pending,
  inFlight,
  degradeReason,
  petName,
  className,
}: PetChatTranscriptProps) {
  const t = useTranslations("pet")
  const you = t("chat.you")
  const pet = petName || t("chat.petFallbackName")
  const endRef = useRef<HTMLDivElement | null>(null)

  // Keep the newest message in view as turns/pending change.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [turns.length, pending, inFlight, degradeReason])

  const empty = turns.length === 0 && !pending

  return (
    <div
      data-testid="pet-chat-transcript"
      className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-auto", className)}
    >
      {empty ? (
        <p className="m-auto text-center text-sm text-muted-foreground">{t("chat.empty")}</p>
      ) : (
        <>
          {turns.map((turn) => (
            <div key={turn.id ?? turn.at} className="flex flex-col gap-2">
              <Bubble who={you} text={turn.userText} mine />
              <Bubble who={pet} text={turn.reply} mine={false} />
            </div>
          ))}
          {pending && <Bubble who={you} text={pending} mine />}
          {inFlight && (
            <p data-testid="pet-chat-typing" className="px-1 text-xs text-muted-foreground">
              {t("chat.sending", { name: pet })}
            </p>
          )}
          {degradeReason && (
            <p
              data-testid="pet-chat-degrade"
              role="status"
              className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
            >
              {t(`chat.degrade.${degradeReason}`)}
            </p>
          )}
        </>
      )}
      <div ref={endRef} />
    </div>
  )
}
