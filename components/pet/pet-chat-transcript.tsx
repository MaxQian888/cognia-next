"use client"

import { useTranslations } from "next-intl"
import { MessageCircleIcon } from "lucide-react"

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import type { PetChatDegradeReason } from "@/lib/pet/chat/respond"
import type { PetConversationRow } from "@/types/pet"

export interface PetChatTranscriptProps {
  turns: PetConversationRow[]
  pending: string | null
  inFlight: boolean
  degradeReason: PetChatDegradeReason | null
  petName?: string | null
  className?: string
}

function PetMessage({
  from,
  who,
  text,
}: {
  from: "user" | "assistant"
  who: string
  text: string
}) {
  return (
    <Message from={from}>
      <span className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{who}</span>
      <MessageContent>
        <MessageResponse>{text}</MessageResponse>
      </MessageContent>
    </Message>
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
  const empty = turns.length === 0 && !pending

  return (
    <Conversation data-testid="pet-chat-transcript" className={cn("min-h-0 flex-1", className)}>
      <ConversationContent className="gap-4 px-1 py-3">
        {empty ? (
          <ConversationEmptyState
            icon={<MessageCircleIcon className="size-8" />}
            title={t("chat.emptyTitle")}
            description={t("chat.empty")}
          />
        ) : (
          <>
            {turns.map((turn) => (
              <div key={turn.id ?? turn.at} className="flex flex-col gap-3">
                <PetMessage from="user" who={you} text={turn.userText} />
                <PetMessage from="assistant" who={pet} text={turn.reply} />
              </div>
            ))}
            {pending ? <PetMessage from="user" who={you} text={pending} /> : null}
            {inFlight ? (
              <p data-testid="pet-chat-typing" className="px-1 text-xs text-muted-foreground">
                {t("chat.sending", { name: pet })}
              </p>
            ) : null}
            {degradeReason ? (
              <Alert data-testid="pet-chat-degrade" role="status">
                <AlertDescription>{t(`chat.degrade.${degradeReason}`)}</AlertDescription>
              </Alert>
            ) : null}
          </>
        )}
      </ConversationContent>
      <ConversationScrollButton aria-label={t("chat.scrollToBottom")} />
    </Conversation>
  )
}
