"use client"

/**
 * Canned-response picker (CRM, schema v83). A composer-toolbar button that
 * opens a searchable list of saved replies; selecting one interpolates its
 * `{{variable}}` tokens against the conversation context and inserts the text
 * into the prompt input at the end of the current draft (mirrors
 * VoiceTranscriptionBridge's controller seam), then bumps the usage counter.
 *
 * Rendered inside the composer's PromptInput provider, gated on an inbox
 * (platform-bound) session, so usePromptInputController is always available.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquareTextIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { usePromptInputController } from "@/components/ai-elements/prompt-input"
import { useCannedResponses } from "@/hooks/connectors/use-canned-responses"
import { incrementUsage } from "@/lib/db/canned-responses"
import { interpolate, type CannedContext } from "@/lib/connectors/canned-interpolate"

export interface CannedResponsePickerProps {
  conversationKey: string
  /** Interpolation context (contact / conversation / operator). */
  context: CannedContext
}

export function CannedResponsePicker({ context }: CannedResponsePickerProps) {
  const t = useTranslations("inbox.cannedResponses")
  const controller = usePromptInputController()
  const canned = useCannedResponses()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const filtered = query.trim()
    ? canned.filter((c) =>
        `${c.title} ${c.body} ${c.shortcut ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
    : canned

  const pick = (id: string, body: string) => {
    const text = interpolate(body, context)
    const cur = controller.textInput.value
    const sep = cur && !cur.endsWith(" ") ? " " : ""
    controller.textInput.setInput(cur ? cur + sep + text : text)
    void incrementUsage(id)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          data-testid="canned-response-trigger"
          aria-label={t("triggerAria")}
        >
          <MessageSquareTextIcon className="size-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="mb-2 h-8"
          data-testid="canned-response-search"
        />
        <div className="max-h-60 space-y-0.5 overflow-y-auto" role="list">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("empty")}</p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                role="listitem"
                onClick={() => pick(c.id, c.body)}
                className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="font-medium">{c.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{c.body}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
