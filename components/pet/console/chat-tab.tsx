// The /pet console "Chat" tab: a real multi-turn conversation with the pet.
// Composes the transcript with the shared talk composer and two escape
// hatches: a one-click enable CTA when the opt-in LLM speak is off, and an
// "Open full chat" button that hands the thread to the main streaming agent
// (seeded draft + route to `/`).
//
// What a turn runs is the console's decision (`usePetConsoleActions().chat`):
// on the desktop, `respondAsPet` here with this window's settings; on a paired
// phone (ADR-0219), `pet_chat_send` to the desktop, which answers with its own
// settings, PII gate and speak limiter. The transcript is a live query on the
// desktop and is fetched on entry on a phone, since the conversation itself is
// never mirrored.
//
// Turning chat on is a desktop setting, so on a phone the CTA explains where
// to do it instead of offering a button.

"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2Icon, MessagesSquareIcon, SparklesIcon, Trash2Icon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
import { seedMainChat } from "@/lib/pet/chat/seed-main-chat"
import { PetChatTranscript } from "../pet-chat-transcript"
import { PetTalkComposer } from "../pet-talk-composer"
import { usePetConsoleActions } from "./pet-console-actions-context"
import { PetTabSkeleton } from "./pet-console-skeleton"

export interface ChatTabProps {
  petName?: string | null
}

export function ChatTab({ petName }: ChatTabProps) {
  const t = useTranslations("pet")
  const router = useRouter()
  const actions = usePetConsoleActions()
  const { chat } = actions
  const [enabling, setEnabling] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const canEnable = actions.capability("chat.enable") === "available"
  // A remote console does not know whether chat is on until the desktop's
  // snapshot arrives; offering the "turn it on" CTA meanwhile would flash.
  const presentationLoading = actions.remote !== null && actions.remote.snapshot === undefined

  const { refresh } = chat
  const loadTranscript = async () => {
    const outcome = await refresh()
    setLoadFailed(!outcome.ok)
  }
  useEffect(() => {
    // Set only after the await, never synchronously in the effect.
    void refresh().then((outcome) => setLoadFailed(!outcome.ok))
  }, [refresh])

  const enable = async () => {
    setEnabling(true)
    try {
      await chat.enable()
    } finally {
      setEnabling(false)
    }
  }

  const openFullChat = () => {
    const turns = chat.turns ?? []
    const seed = chat.pending ?? turns[turns.length - 1]?.userText ?? ""
    void seedMainChat(seed).then(() => router.push("/"))
  }

  if (presentationLoading) return <PetTabSkeleton testId="pet-chat-loading" count={4} />

  if (!chat.enabled) {
    return (
      <Empty data-testid="pet-chat-enable-cta" className="m-auto max-w-sm">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SparklesIcon />
          </EmptyMedia>
          <EmptyTitle>
            {canEnable ? t("chat.enableCta.title") : t("console.remote.chatOff.title")}
          </EmptyTitle>
          <EmptyDescription>
            {canEnable ? t("chat.enableCta.body") : t("console.remote.chatOff.body")}
          </EmptyDescription>
        </EmptyHeader>
        {canEnable ? (
          <EmptyContent>
            <Button
              className="min-h-11"
              disabled={enabling}
              aria-busy={enabling || undefined}
              onClick={() => void enable()}
            >
              {enabling ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : null}
              {t("chat.enableCta.action")}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    )
  }

  if (chat.turns === undefined) {
    return loadFailed ? (
      <Empty data-testid="pet-chat-load-failed" className="m-auto max-w-sm">
        <EmptyHeader>
          <EmptyTitle>{t("console.remote.chatLoadFailed")}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" className="min-h-11" onClick={() => void loadTranscript()}>
            {t("console.remote.band.retry")}
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <PetTabSkeleton testId="pet-chat-loading" count={4} />
    )
  }

  const hasHistory = chat.turns.length > 0

  return (
    <div
      data-testid="pet-chat-tab"
      className={cn("mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-3")}
    >
      <PetChatTranscript
        turns={chat.turns}
        pending={chat.pending}
        inFlight={chat.inFlight}
        degradeReason={chat.degradeReason}
        petName={petName}
      />
      {chat.awaitingReply ? (
        <p
          data-testid="pet-chat-awaiting"
          role="status"
          className="px-1 text-xs text-muted-foreground"
        >
          {t("console.remote.chatPending")}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <PetTalkComposer
          mode="chat"
          status={chat.inFlight ? "submitted" : chat.degradeReason ? "error" : "ready"}
          allowEmpty={false}
          onTalk={(text) => text && void chat.send(text)}
        />
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 text-muted-foreground hover:text-foreground md:min-h-8"
            onClick={openFullChat}
          >
            <MessagesSquareIcon className="size-3.5" />
            {t("chat.openFullChat")}
          </Button>
          {hasHistory ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="pet-chat-clear"
                  className="min-h-11 text-muted-foreground hover:text-foreground md:min-h-8"
                >
                  <Trash2Icon className="size-3.5" />
                  {t("console.chat.clear")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("console.chat.clearConfirm.title")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("console.chat.clearConfirm.description")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("console.chat.clearConfirm.cancel")}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void chat.clear()}>
                    {t("console.chat.clearConfirm.confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>
    </div>
  )
}
