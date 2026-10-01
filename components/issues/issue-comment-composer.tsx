"use client"

/**
 * Comment box for the activity trail.
 *
 * The panel has always RENDERED comments — they are `issueEvents` rows of kind
 * `commented` — but `addIssueComment` had no caller anywhere in the app, so
 * there was no way to write one. A trail that shows other people's comments
 * and offers no way to reply is the clearest possible "built but dormant".
 *
 * Local and collaboration issues get one: a GitHub mirror's comment goes
 * through the write-back dialog instead, because it has to reach GitHub, and
 * an agent task has no comment concept at all.
 *
 * # Mentions (ADR-0207 §2)
 *
 * When the caller passes `mentionCandidates` (collaboration issues, where a
 * mention notifies a workspace member), an `@` button opens a person picker;
 * typing an `@` that starts a word opens it too. Picking inserts
 * `@Display Name ` at the caret and records the id. On send, the recorded ids
 * whose token is still in the text are passed as `mentions`: the text is never
 * parsed for names, because display names are not unique. With no candidates
 * there is no picker and `mentions` is always empty.
 */

import { AtSignIcon, SendHorizontalIcon } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"

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
import { Textarea } from "@/components/ui/textarea"
import {
  declaredMentionIds,
  insertMention,
  typedMentionTrigger,
  type DeclaredMention,
} from "@/lib/issues/comment-mentions"

export interface IssueCommentMentionCandidate {
  userId: string
  displayName: string
}

export interface IssueCommentComposerProps {
  /**
   * `mentions` are the declared `usr_…` ids still present in the text; always
   * empty when no `mentionCandidates` were offered.
   */
  onSubmit: (body: string, mentions: string[]) => Promise<void> | void
  disabled?: boolean
  /** People the comment may mention. Absent or empty: no picker. */
  mentionCandidates?: readonly IssueCommentMentionCandidate[]
}

const NO_CANDIDATES: readonly IssueCommentMentionCandidate[] = []

export function IssueCommentComposer({
  onSubmit,
  disabled,
  mentionCandidates,
}: IssueCommentComposerProps) {
  const t = useTranslations("issues")
  const format = useFormatter()
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [recorded, setRecorded] = useState<DeclaredMention[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Where the picked name goes: the selection when the picker opened, or the
  // typed `@`. Written in handlers only.
  const pickRangeRef = useRef<{ start: number; end: number } | null>(null)
  const caretAfterPickRef = useRef<number | null>(null)

  const candidates = mentionCandidates ?? NO_CANDIDATES
  const canMention = candidates.length > 0
  const trimmed = body.trim()
  const canSend = trimmed.length > 0 && !busy && !disabled
  const inert = Boolean(disabled) || busy

  const mentionIds = useMemo(
    () => (canMention ? declaredMentionIds(trimmed, recorded) : []),
    [canMention, trimmed, recorded]
  )
  const mentionNames = useMemo(() => {
    const byId = new Map(recorded.map((mention) => [mention.userId, mention.displayName]))
    return mentionIds.map((id) => byId.get(id) ?? id)
  }, [mentionIds, recorded])
  // Two people can share a display name; the id tells them apart in the list.
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const candidate of candidates) {
      counts.set(candidate.displayName, (counts.get(candidate.displayName) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
  }, [candidates])

  async function send() {
    if (!canSend) return
    setBusy(true)
    try {
      await onSubmit(trimmed, mentionIds)
      // Cleared only on success: a failed write must leave the text where the
      // user can retry it, and reporting the failure is the caller's job.
      setBody("")
      setRecorded([])
    } catch {
      // Swallowed deliberately — see above. Re-throwing here would surface as
      // an unhandled rejection from the click handler and change nothing for
      // the user.
    } finally {
      setBusy(false)
    }
  }

  function openPicker(range: { start: number; end: number }) {
    pickRangeRef.current = range
    caretAfterPickRef.current = null
    setPickerOpen(true)
  }

  function currentSelection(): { start: number; end: number } {
    const element = textareaRef.current
    return element
      ? { start: element.selectionStart, end: element.selectionEnd }
      : { start: body.length, end: body.length }
  }

  function pick(candidate: IssueCommentMentionCandidate) {
    const range = pickRangeRef.current ?? { start: body.length, end: body.length }
    const next = insertMention(body, range, candidate.displayName)
    setBody(next.body)
    setRecorded((previous) => [
      ...previous,
      { userId: candidate.userId, displayName: candidate.displayName },
    ])
    caretAfterPickRef.current = next.caret
    pickRangeRef.current = null
    setPickerOpen(false)
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="issue-comment-composer">
      <Textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => {
          const next = event.target.value
          if (canMention && !inert) {
            const trigger = typedMentionTrigger(body, next, event.target.selectionStart)
            if (trigger !== null) openPicker({ start: trigger, end: trigger + 1 })
          }
          setBody(next)
        }}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter sends; a bare Enter is a newline, because comments
          // routinely run to more than one line.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
        rows={2}
        disabled={inert}
        placeholder={t("detail.commentPlaceholder")}
        aria-label={t("detail.comment")}
        className="min-h-16 text-sm"
        data-testid="issue-comment-input"
      />
      <div className="flex items-center gap-1.5">
        {canMention ? (
          <Popover
            open={pickerOpen}
            onOpenChange={(open) => {
              if (open) openPicker(currentSelection())
              else setPickerOpen(false)
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={inert}
                aria-label={t("detail.mention.trigger")}
                title={t("detail.mention.trigger")}
                data-testid="issue-comment-mention-trigger"
              >
                <AtSignIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-64 p-0"
              data-testid="issue-comment-mention-picker"
              onCloseAutoFocus={(event) => {
                // Back to the text, not the `@` button, with the caret after
                // the inserted name (or where it was, when nothing was picked).
                event.preventDefault()
                const element = textareaRef.current
                if (!element) return
                element.focus()
                const caret = caretAfterPickRef.current
                caretAfterPickRef.current = null
                if (caret !== null) element.setSelectionRange(caret, caret)
              }}
            >
              <Command>
                <CommandInput placeholder={t("detail.mention.search")} />
                <CommandList>
                  <CommandEmpty>{t("detail.mention.empty")}</CommandEmpty>
                  <CommandGroup heading={t("detail.mention.heading")}>
                    {candidates.map((candidate) => (
                      <CommandItem
                        key={candidate.userId}
                        value={`${candidate.displayName} ${candidate.userId}`}
                        onSelect={() => pick(candidate)}
                        data-testid="issue-comment-mention-option"
                      >
                        <span className="flex-1 truncate">{candidate.displayName}</span>
                        {duplicateNames.has(candidate.displayName) ? (
                          <span className="ml-2 truncate font-mono text-[10px] text-muted-foreground">
                            {candidate.userId}
                          </span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : null}
        {mentionNames.length > 0 ? (
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid="issue-comment-mentions"
          >
            {t("detail.mention.willNotify", {
              names: format.list(mentionNames, { type: "conjunction" }),
            })}
          </span>
        ) : null}
        <Button
          size="sm"
          className="ml-auto"
          disabled={!canSend}
          onClick={() => void send()}
          data-testid="issue-comment-submit"
        >
          <SendHorizontalIcon className="size-3.5" />
          {t("detail.comment")}
        </Button>
      </div>
    </div>
  )
}
