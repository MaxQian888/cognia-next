// The /pet console "Chat" tab: a real multi-turn conversation with the pet.
// Composes the durable transcript (`usePetChat`) with the shared talk composer
// and two escape hatches — a one-click enable CTA when the opt-in LLM speak is
// off, and an "Open full chat" button that hands the thread to the main
// streaming agent (seeded draft + route to `/`). Main window only.

"use client"

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { MessagesSquareIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { usePetChat } from "@/hooks/pet/use-pet-chat"
import { seedMainChat } from "@/lib/pet/chat/seed-main-chat"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_SETTINGS, type PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { PetChatTranscript } from "../pet-chat-transcript"
import { PetTalkComposer } from "../pet-talk-composer"

export interface ChatTabProps {
  profile: PetProfile
  view: PetView
  activeCharacterId?: string | null
}

export function ChatTab({ profile, view, activeCharacterId }: ChatTabProps) {
  const t = useTranslations("pet")
  const router = useRouter()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const pet = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const llmOn = Boolean(pet.llmSpeak?.enabled)

  const { turns, pending, degradeReason, inFlight, send } = usePetChat({
    profile,
    view,
    activeCharacterId,
  })

  const enableLlm = () => {
    void save({ petSettings: { ...pet, llmSpeak: { ...pet.llmSpeak, enabled: true } } })
  }

  const openFullChat = () => {
    const seed = pending ?? turns[turns.length - 1]?.userText ?? ""
    void seedMainChat(seed).then(() => router.push("/"))
  }

  return (
    <div
      data-testid="pet-chat-tab"
      className={cn("mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-3")}
    >
      {llmOn ? (
        <>
          <PetChatTranscript
            turns={turns}
            pending={pending}
            inFlight={inFlight}
            degradeReason={degradeReason}
            petName={profile.soul?.name}
          />
          <div className="flex flex-col gap-2">
            <PetTalkComposer
              mode="chat"
              status={inFlight ? "submitted" : degradeReason ? "error" : "ready"}
              allowEmpty={false}
              onTalk={(text) => text && void send(text)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="self-start text-muted-foreground hover:text-foreground"
              onClick={openFullChat}
            >
              <MessagesSquareIcon className="size-3.5" />
              {t("chat.openFullChat")}
            </Button>
          </div>
        </>
      ) : (
        <Empty data-testid="pet-chat-enable-cta" className="m-auto max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon />
            </EmptyMedia>
            <EmptyTitle>{t("chat.enableCta.title")}</EmptyTitle>
            <EmptyDescription>{t("chat.enableCta.body")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={enableLlm}>{t("chat.enableCta.action")}</Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  )
}
