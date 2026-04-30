"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { loggers } from "@/lib/logger"
import type { ChatSession } from "@/lib/claude/types"
import {
  HashIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"

const log = loggers.ui

export interface SessionRowProps {
  session: ChatSession
  active: boolean
  /** Optional dot color (assistant character avatarColor) shown left of title. */
  accentColor?: string
  /** Optional unread count → shows a badge. */
  unread?: number
  onSelect: (id: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
}

/**
 * The row used in the channel list — extracted from the legacy SessionSidebar
 * so the new Discord shell and any other surface can share rename/delete UX.
 *
 * Double-click the title to rename inline. Enter commits, Escape cancels.
 */
export function SessionRow({
  session,
  active,
  accentColor,
  unread,
  onSelect,
  onDelete,
  onRename,
}: SessionRowProps) {
  const t = useTranslations("desktop.sessionRow")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!editing) setDraft(session.title)
  }, [editing, session.title])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    const next = draft.trim()
    if (next && next !== session.title) {
      log.info("session rename commit", { sessionId: session.id, length: next.length })
      void onRename(session.id, next)
    } else {
      setDraft(session.title)
    }
    setEditing(false)
  }

  const cancel = () => {
    log.info("session rename cancel", { sessionId: session.id })
    setDraft(session.title)
    setEditing(false)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      commit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancel()
    }
  }

  const handleSelect = () => {
    log.info("session select", { sessionId: session.id, kind: session.kind })
    onSelect(session.id)
  }

  const handleDelete = () => {
    log.info("session delete", { sessionId: session.id, kind: session.kind })
    void onDelete(session.id)
  }

  const Icon =
    session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon

  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
        active && "bg-accent"
      )}
    >
      {editing ? (
        <div className="flex flex-1 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            className="h-6 px-1 py-0 text-sm"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={handleSelect}
          onDoubleClick={() => setEditing(true)}
          className="flex flex-1 items-center gap-2 truncate text-left"
          title={session.title}
        >
          {accentColor ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: accentColor }}
              aria-hidden
            />
          ) : (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{session.title || t("untitled")}</span>
          {unread && unread > 0 ? (
            <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </button>
      )}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label={t("actionsMenu")}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <PencilIcon className="mr-2 size-4" />
              {t("rename")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={handleDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2Icon className="mr-2 size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
}
