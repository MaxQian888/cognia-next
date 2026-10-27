"use client"

import { useRef, useState, type ReactElement } from "react"
import { useTranslations } from "next-intl"
import { LinkIcon, PlusIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSharedChatEnabled } from "@/hooks/collab/use-shared-chat-enabled"
import { SharedSessionJoin } from "./shared-session-join"

/** Shared by the desktop rail, compact list header, and mobile list's +. */
export function ConversationCreateMenu({
  children,
  onNewConversation,
  newConversationLabel,
}: {
  children: ReactElement
  onNewConversation: () => void
  newConversationLabel: string
}) {
  const t = useTranslations("chatCollaboration")
  const sharedChatEnabled = useSharedChatEnabled()
  const [joinOpen, setJoinOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild ref={triggerRef}>
          {children}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            // The invitation dialog takes focus when its menu item is chosen.
            if (joinOpen) event.preventDefault()
          }}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem className="pointer-coarse:min-h-11" onSelect={onNewConversation}>
              <PlusIcon className="size-4" aria-hidden />
              {newConversationLabel}
            </DropdownMenuItem>
            {sharedChatEnabled ? (
              <DropdownMenuItem
                className="pointer-coarse:min-h-11"
                onSelect={() => setJoinOpen(true)}
              >
                <LinkIcon className="size-4" aria-hidden />
                {t("joinViaInvite")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {sharedChatEnabled && joinOpen ? (
        <SharedSessionJoin
          open={joinOpen}
          onOpenChange={setJoinOpen}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}
