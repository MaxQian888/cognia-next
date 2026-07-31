"use client"

/**
 * In-chat memory transparency chips (ADR-0069 round 2).
 *
 * Rendered under an assistant message once its turn has completed:
 * - `MemoryLearnedChip` — "记住了 N 条": what the async post-turn extraction
 *   learned from this reply. Reactive via the v122 `sourceMessageId` index, so
 *   the chip appears when the job lands (seconds after the turn) and updates
 *   live on edit/撤销. Popover rows offer inline edit, undo (soft-invalidate),
 *   and a deep link into the /memory console.
 * - `MemoryRecalledChip` — "引用了 N 条记忆": which stored memories were
 *   injected into this turn's context. Data source is the message's persisted
 *   SourcesPart (`origin: "memory"`), so it survives reloads; rows resolve to
 *   live Dexie rows when possible and fall back to the persisted snippet.
 *
 * Perf contract: both chips mount only for non-streaming messages (gated at
 * the call site) and keep their liveQuery inside the chip, so nothing here
 * runs in the token-delta hot path.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  BrainIcon,
  CheckIcon,
  ExternalLinkIcon,
  PencilIcon,
  QuoteIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react"
import { motion } from "motion/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { useLearnedMemories, useRecalledMemories } from "@/hooks/memory/use-message-memories"
import { usePlatform } from "@/hooks/use-platform"
import type { SourcesPart } from "@/lib/claude/parts-extensions"
import { manageMemory, type ManageMemoryResult } from "@/lib/memory/control-plane/manage"
import { cn } from "@/lib/utils"
import type { Memory } from "@/types/memory/memory"

const CHIP_MOTION = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.18 },
} as const

/**
 * Popover on desktop, bottom drawer on the Capacitor mobile shell. The chip
 * trigger is shared; only the surface differs.
 */
function ChipSurface({
  trigger,
  title,
  children,
}: {
  trigger: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  const isMobile = usePlatform() === "mobile"
  if (isMobile) {
    return (
      <Drawer>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="pb-2">
            <DrawerTitle className="text-sm">{title}</DrawerTitle>
          </DrawerHeader>
          <div className="max-h-[60vh] overflow-y-auto px-4 pb-6 text-xs">{children}</div>
        </DrawerContent>
      </Drawer>
    )
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-80 p-3 text-xs">
        <p className="mb-2 text-xs font-semibold">{title}</p>
        {children}
      </PopoverContent>
    </Popover>
  )
}

function surfaceMutationError(result: ManageMemoryResult, t: (key: string) => string): boolean {
  if (result.ok) return false
  toast.error(t(`memoryChips.errors.${result.reason}`))
  return true
}

/** "记住了 N 条" — memories extracted from this assistant reply. */
export function MemoryLearnedChip({ messageId }: { messageId: string }) {
  const t = useTranslations("chat")
  const memories = useLearnedMemories(messageId)
  if (memories.length === 0) return null

  return (
    <ChipSurface
      title={t("memoryChips.learnedTitle")}
      trigger={
        <motion.button
          {...CHIP_MOTION}
          type="button"
          aria-label={t("memoryChips.learnedAria")}
          className="inline-flex"
          data-testid="memory-learned-chip"
        >
          <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
            <BrainIcon className="size-3 text-violet-500" />
            {t("memoryChips.learnedLabel", { count: memories.length })}
          </Badge>
        </motion.button>
      }
    >
      <ul className="space-y-2">
        {memories.map((memory) => (
          <LearnedRow key={memory.id} memory={memory} />
        ))}
      </ul>
    </ChipSurface>
  )
}

function LearnedRow({ memory }: { memory: Memory }) {
  const t = useTranslations("chat")
  const tTypes = useTranslations("memory.types")
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.text)
  const [busy, setBusy] = useState(false)
  const undone = memory.status === "invalidated"

  const save = async () => {
    const text = draft.trim()
    if (!text || text === memory.text) {
      setEditing(false)
      return
    }
    setBusy(true)
    const result = await manageMemory({ kind: "update", id: memory.id, patch: { text } })
    setBusy(false)
    if (surfaceMutationError(result, t)) return
    setEditing(false)
  }

  const undo = async () => {
    setBusy(true)
    const result = await manageMemory({ kind: "invalidate", id: memory.id })
    setBusy(false)
    surfaceMutationError(result, t)
  }

  return (
    <li className="flex flex-col gap-1 border-b border-border/40 pb-2 last:border-b-0 last:pb-0">
      {editing ? (
        <div className="flex flex-col gap-1">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            className="text-xs"
            aria-label={t("memoryChips.editAria")}
          />
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                setDraft(memory.text)
                setEditing(false)
              }}
            >
              <XIcon className="size-3" />
              {t("memoryChips.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy || !draft.trim()}
              onClick={() => void save()}
            >
              <CheckIcon className="size-3" />
              {t("memoryChips.save")}
            </Button>
          </div>
        </div>
      ) : (
        <p className={cn("text-xs leading-snug", undone && "text-muted-foreground line-through")}>
          {memory.text}
        </p>
      )}
      <div className="flex items-center gap-1">
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {tTypes(memory.type)}
        </Badge>
        {undone && (
          <Badge variant="outline" className="px-1 py-0 text-[10px] text-muted-foreground">
            {t("memoryChips.undone")}
          </Badge>
        )}
        <span className="flex-1" />
        {!undone && !editing && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="size-5"
              aria-label={t("memoryChips.edit")}
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              <PencilIcon className="size-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-5"
              aria-label={t("memoryChips.undo")}
              disabled={busy}
              onClick={() => void undo()}
            >
              <Undo2Icon className="size-3" />
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-5"
          aria-label={t("memoryChips.details")}
          onClick={() => router.push(`/memory?id=${encodeURIComponent(memory.id)}`)}
        >
          <ExternalLinkIcon className="size-3" />
        </Button>
      </div>
    </li>
  )
}

/** "引用了 N 条记忆" — stored memories injected into this turn's context. */
export function MemoryRecalledChip({ part }: { part: SourcesPart }) {
  const t = useTranslations("chat")
  const router = useRouter()
  const items = part.sources.filter((source) => source.origin === "memory")
  const ids = items.map((source) => source.id.replace(/^memory-/, ""))
  const resolved = useRecalledMemories(ids)
  if (items.length === 0 && !part.memoryDegraded) return null

  return (
    <ChipSurface
      title={t("memoryChips.recalledTitle")}
      trigger={
        <motion.button
          {...CHIP_MOTION}
          type="button"
          aria-label={t("memoryChips.recalledAria")}
          className="inline-flex"
          data-testid="memory-recalled-chip"
        >
          <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
            <QuoteIcon className="size-3 text-sky-500" />
            {t("memoryChips.recalledLabel", { count: items.length })}
          </Badge>
        </motion.button>
      }
    >
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item, index) => {
            const id = ids[index]
            const live = resolved.find((ref) => ref.id === id)?.memory
            const text = live?.text ?? item.snippet ?? item.title
            return (
              <li
                key={item.id}
                className="flex flex-col gap-0.5 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
              >
                <p className="text-xs leading-snug">{text}</p>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  {item.score !== undefined && <span>{Math.round(item.score * 100)}%</span>}
                  {!live && <span>{t("memoryChips.deletedFallback")}</span>}
                  <span className="flex-1" />
                  {live && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5"
                      aria-label={t("memoryChips.details")}
                      onClick={() => router.push(`/memory?id=${encodeURIComponent(id)}`)}
                    >
                      <ExternalLinkIcon className="size-3" />
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {(part.memoryBudget || part.memoryDegraded) && (
        <div className="mt-2 space-y-0.5 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground">
          {part.memoryBudget && (
            <p>
              {t("memoryChips.budgetLine", {
                used: part.memoryBudget.used,
                limit: part.memoryBudget.limit,
              })}
              {part.memoryBudget.truncated && ` · ${t("memoryChips.truncated")}`}
            </p>
          )}
          {part.memoryDegraded && <p>{t("memoryChips.degradedNotice")}</p>}
        </div>
      )}
    </ChipSurface>
  )
}
