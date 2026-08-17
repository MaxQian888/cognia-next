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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { usePromptInputController } from "@/components/ai-elements/prompt-input"
import { useCannedResponses } from "@/hooks/connectors/use-canned-responses"
import { incrementUsage } from "@/lib/db/canned-responses"
import {
  CANNED_VARIABLES,
  interpolate,
  type CannedContext,
} from "@/lib/connectors/canned-interpolate"

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
    ? canned.filter((response) =>
        `${response.title} ${response.body} ${response.shortcut ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
    : canned

  /** Append `text` to the composer draft with a single-space separator. */
  const insertText = (text: string) => {
    const cur = controller.textInput.value
    const sep = cur && !cur.endsWith(" ") ? " " : ""
    controller.textInput.setInput(cur ? cur + sep + text : text)
    setOpen(false)
    setQuery("")
  }

  const pick = (id: string, body: string) => {
    insertText(interpolate(body, context))
    void incrementUsage(id)
  }

  // Variable chips: each `{{token}}` from CANNED_VARIABLES resolved against the
  // live conversation context. Clicking inserts the *resolved value* (never
  // the raw token — nothing downstream of the composer interpolates, so a
  // literal `{{contact.name}}` would reach the recipient). Tokens with no
  // value in this conversation render disabled rather than inserting "".
  const variables = CANNED_VARIABLES.map((name) => ({
    name,
    token: `{{${name}}}`,
    value: interpolate(`{{${name}}}`, context),
  }))

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
      <PopoverContent align="start" className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("searchPlaceholder")}
            data-testid="canned-response-search"
          />
          <CommandList className="max-h-60">
            <CommandEmpty>{t("empty")}</CommandEmpty>
            <CommandGroup>
              {filtered.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.title} ${c.body} ${c.shortcut ?? ""}`}
                  onSelect={() => pick(c.id, c.body)}
                  className="flex-col items-start gap-0.5"
                  data-testid={`canned-response-${c.id}`}
                >
                  <span className="font-medium">{c.title}</span>
                  <span className="w-full truncate text-xs text-muted-foreground">{c.body}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="border-t px-2 py-1.5" data-testid="canned-response-variables">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("variablesHint")}
            </p>
            <div className="flex flex-wrap gap-1">
              {variables.map(({ name, token, value }) => {
                const unavailable = value.length === 0
                return (
                  <button
                    key={name}
                    type="button"
                    disabled={unavailable}
                    onClick={() => insertText(value)}
                    aria-label={t("insertVariableAria", { name: token })}
                    title={unavailable ? t("variableUnavailable", { name: token }) : value}
                    data-testid={`canned-variable-${name}`}
                    className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <code>{token}</code>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="border-t p-2">
            <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
              <a href="/settings?section=connections&connectionsTab=assets">{t("manage")}</a>
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
