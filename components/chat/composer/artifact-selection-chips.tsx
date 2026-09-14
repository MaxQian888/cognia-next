"use client"

// Context chips for material the user pointed at + commented on. Sits in the
// ContextChipBar alongside @-references and attachments. Clicking the X drops
// the selection from the chat store; sending consumes them (and records the
// edit target so the AI reply routes into a review proposal).
//
// Only the first ARTIFACT chip becomes that edit target — the rest contribute
// context alone (`composer.tsx`). That was invisible: every chip looked
// identical and the drop was recorded in a `debug` log, so referencing two
// artifacts silently meant one of them could never receive a revision proposal.
// The lead chip now says so, and clicking another artifact chip promotes it.
//
// File / comment / web chips never carry the badge and never promote: there is
// nothing for a per-hunk proposal to diff them against, so offering the control
// would promise a round trip that cannot happen.

import { useCallback, useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ChevronsUpDownIcon,
  DatabaseIcon,
  RefreshCwIcon,
  FileDiff,
  FileCodeIcon,
  GlobeIcon,
  ListIcon,
  MessageSquareIcon,
  PuzzleIcon,
  ScanTextIcon,
  XIcon,
} from "lucide-react"
import {
  selectComposerContextSelections,
  useChatStore,
  useComposerContextSelections,
} from "@/stores/chat"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  MAX_MESSAGE_SPAN,
  buildMessageReferenceText,
  clampSpan,
  parseMessageRefId,
} from "@/lib/chat/mentions/message-reference"
import {
  entitySelectionFrom,
  entitySnapshotBody,
  getEntityMentionSource,
} from "@/lib/chat/mentions/entity-sources"
import { refreshSelectionFreshness } from "@/lib/chat/mentions/selection-freshness"
import { contextSelectionIdentity } from "@/lib/chat/mentions/selection-identity"
import { refreshMessageExcerpt } from "@/lib/chat/selection/message-excerpt"
import {
  isMessageSetReference,
  rebuildMessageSetReference,
} from "@/lib/chat/selection/message-set-reference"
import type { ContextSelectionRef } from "@/types/artifact/artifact"
import { useComposerSessionId } from "./composer-session-context"

export interface ArtifactSelectionChipsProps {
  /** Render bare (no padded container) for composition inside ContextChipBar. */
  bare?: boolean
}

const KIND_ICONS = {
  artifact: FileDiff,
  file: FileCodeIcon,
  comment: MessageSquareIcon,
  web: GlobeIcon,
  external: ScanTextIcon,
  plugin: PuzzleIcon,
  entity: DatabaseIcon,
} as const

export function ArtifactSelectionChips({ bare = false }: ArtifactSelectionChipsProps = {}) {
  const t = useTranslations("artifacts.review")
  // The `@memory:` / `@issue:` / … nouns live with the picker's own copy, not
  // with the review panel's — one catalogue per vocabulary.
  const tEntity = useTranslations("chat.composer.popover.entityKinds")
  const composerSessionId = useComposerSessionId()
  // This pane's conversation, matching the `remove` / `promote` writes below —
  // and `remove` takes an INDEX, so reading a different slice than the one
  // being written would drop whichever selection happened to sit at that index.
  const selections = useComposerContextSelections(composerSessionId)
  const remove = useChatStore((s) => s.removeContextSelection)
  const promote = useChatStore((s) => s.promoteContextSelection)
  const replace = useChatStore((s) => s.replaceContextSelection)

  // Re-check on mount and whenever the window regains focus. Those are the two
  // moments a chip can have gone stale without this pane hearing about it: the
  // record was edited in another window, or on another surface of this one.
  useEffect(() => {
    let cancelled = false
    const check = () => {
      const current = useChatStore.getState()
      const staged = selectComposerContextSelections(current, composerSessionId)
      if (staged.length === 0) return
      // `.catch` and not a bare `void`: this runs on every focus, and a failed
      // read must leave the chips exactly as they are rather than take the bar
      // down with an unhandled rejection.
      refreshSelectionFreshness(staged)
        .then((pass) => {
          if (cancelled || !pass.changed) return
          // Written back one at a time through the same index-addressed action
          // the rest of this component uses, so a concurrent add or remove cannot
          // be clobbered by a whole-list write.
          pass.selections.forEach((selection, index) => {
            if (selection !== staged[index]) {
              useChatStore.getState().replaceContextSelection(index, selection, composerSessionId)
            }
          })
        })
        .catch(() => undefined)
    }
    check()
    window.addEventListener("focus", check)
    return () => {
      cancelled = true
      window.removeEventListener("focus", check)
    }
  }, [composerSessionId])

  const refresh = useCallback(
    async (index: number, sel: ContextSelectionRef) => {
      if (sel.kind !== "entity") return
      // Several whole messages: every one is read again. Refreshing through the
      // message source would read only the first and quietly drop the rest.
      if (isMessageSetReference(sel)) {
        try {
          const next = await rebuildMessageSetReference(sel)
          if (next) replace(index, next, composerSessionId)
          else toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
        } catch {
          toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
        }
        return
      }
      // An excerpt is a part of a message the user chose. Re-reading the message
      // would replace that part with the whole; the refresh asks whether the
      // message still says what was selected instead.
      const { excerpt } = sel
      if (excerpt) {
        try {
          const outcome = await refreshMessageExcerpt({ ...sel, excerpt })
          if (outcome.kind === "current") replace(index, outcome.selection, composerSessionId)
          else if (outcome.kind === "changed") toast.error(t("selectionExcerptChanged"))
          else toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
        } catch {
          toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
        }
        return
      }
      const source = getEntityMentionSource(sel.entityKind)
      if (!source) return
      const candidate = {
        entityKind: sel.entityKind,
        id: sel.entityId,
        title: sel.title,
        searchText: "",
        ...(sel.subtitle ? { subtitle: sel.subtitle } : {}),
        ...(sel.href ? { href: sel.href } : {}),
        ...(sel.sourceSessionId ? { sourceSessionId: sel.sourceSessionId } : {}),
      }
      try {
        // A widened message reference is re-read AT its span. `source.snapshot`
        // knows nothing about spans, so refreshing through it silently narrowed
        // the body back to one message while the chip kept saying "N turns".
        const span = sel.span
        const widened = sel.entityKind === "message" && span && (span.before > 0 || span.after > 0)
        const parsed = widened ? parseMessageRefId(sel.entityId) : null
        const body =
          widened && parsed
            ? await buildMessageReferenceText({ ...parsed, span })
            : await source.snapshot(candidate)
        // Gone, not merely changed. Leaving the old body in place and saying so
        // beats replacing it with nothing.
        if (!body?.trim()) {
          toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
          return
        }
        const fingerprint = source.fingerprint
          ? await source.fingerprint(candidate).catch(() => undefined)
          : undefined
        replace(
          index,
          {
            ...entitySelectionFrom(candidate, body, { fingerprint }),
            // The user's own annotation and their chosen span survive a
            // refresh: neither is a property of the source.
            comment: sel.comment,
            ...(sel.span ? { span: sel.span } : {}),
          },
          composerSessionId
        )
      } catch {
        toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
      }
    },
    [replace, composerSessionId, t]
  )

  /**
   * Take one message out of a combined reference. The rest are read again rather
   * than the body being patched, so what is sent is what is stored now; the chip
   * goes when nothing is left.
   */
  const removeMember = useCallback(
    async (index: number, sel: ContextSelectionRef, memberId: string) => {
      if (sel.kind !== "entity") return
      try {
        const next = await rebuildMessageSetReference(sel, { without: memberId })
        if (next) replace(index, next, composerSessionId)
        else remove(index, composerSessionId)
      } catch {
        toast.error(t("selectionRefreshUnavailable", { title: sel.title }))
      }
    },
    [remove, replace, composerSessionId, t]
  )

  const widen = useCallback(
    async (index: number, sel: ContextSelectionRef) => {
      if (sel.kind !== "entity" || sel.entityKind !== "message") return
      const parsed = parseMessageRefId(sel.entityId)
      if (!parsed) return
      const current = sel.span ?? { before: 0, after: 0 }
      // One step widens BOTH sides. A reference is to an exchange, and a
      // one-sided stepper would need two controls on a chip that has room for
      // one — the asymmetric case is served by picking a different anchor.
      const next = clampSpan({ before: current.before + 1, after: current.after + 1 })
      if (next.before === current.before && next.after === current.after) return
      const body = await buildMessageReferenceText({ ...parsed, span: next })
      // The anchor was deleted between the pick and the widen. Saying so beats
      // leaving a chip that silently kept its old, narrower body while claiming
      // a wider span.
      if (!body) {
        toast.error(t("selectionSpanUnavailable"))
        return
      }
      replace(
        index,
        { ...sel, span: next, snapshot: entitySnapshotBody("message", body) },
        composerSessionId
      )
    },
    [replace, composerSessionId, t]
  )

  if (selections.length === 0) return null

  function labelFor(sel: ContextSelectionRef): string {
    switch (sel.kind) {
      case "artifact": {
        // A whole-artifact reference (the dock tab's "reference in chat") is
        // staged as lines 1..N of the snapshot, which rendered as a line range
        // and read like a hand-picked excerpt. Derived from the snapshot rather
        // than a flag, so a selection that happens to cover everything reads the
        // same way — which is what it is.
        const whole =
          sel.range.startLine === 1 && sel.range.endLine >= sel.snapshot.split("\n").length
        return whole
          ? t("selectionChipWholeLabel", { title: sel.title })
          : t("selectionChipLabel", {
              title: sel.title,
              start: sel.range.startLine,
              end: sel.range.endLine,
            })
      }
      case "file":
        return sel.range
          ? t("selectionChipLabel", {
              title: sel.relPath,
              start: sel.range.startLine,
              end: sel.range.endLine,
            })
          : t("selectionChipFileLabel", { path: sel.relPath })
      case "comment":
        return t("selectionChipCommentLabel", { title: sel.title })
      case "web":
        return t("selectionChipWebLabel", { title: sel.title })
      case "external":
        if (sel.truncated) {
          return t("selectionChipExternalTruncatedLabel", {
            app: sel.sourceApp,
            title: sel.sourceTitle ?? sel.title,
          })
        }
        return sel.sourceTitle
          ? t("selectionChipExternalLabel", {
              app: sel.sourceApp,
              title: sel.sourceTitle,
            })
          : t("selectionChipExternalAppLabel", { app: sel.sourceApp })
      case "plugin":
        return t("selectionChipPluginLabel", {
          source: sel.sourceLabel,
          title: sel.title,
        })
      case "entity": {
        // What was selected, and what the body is: the selection itself or text
        // generated from it. A chip that just said "message" would hide both.
        if (sel.excerpt) {
          const across = sel.members && sel.members.length > 1 ? sel.members.length : 0
          return across
            ? t("selectionChipExcerptAcrossLabel", {
                derivation: sel.excerpt.derivation,
                title: sel.title,
                count: across,
              })
            : t("selectionChipExcerptLabel", {
                derivation: sel.excerpt.derivation,
                title: sel.title,
              })
        }
        // Several whole messages, counted: the title is only the first one's.
        if (isMessageSetReference(sel)) {
          return t("selectionChipMessagesLabel", {
            count: sel.members?.length ?? 0,
            title: sel.title,
          })
        }
        // A widened `@msg:` reference is no longer "a message" — it carries the
        // turns around it, and a chip that still said "message" would understate
        // what is about to be sent.
        const span = sel.span
        if (sel.entityKind === "message" && span && (span.before > 0 || span.after > 0)) {
          return t("selectionChipMessageSpanLabel", {
            title: sel.title,
            count: span.before + span.after + 1,
          })
        }
        // The kind noun is localized (`tEntity`), the record title is not —
        // it is the user's own text and must read back exactly as they saw it
        // in the picker.
        return t("selectionChipEntityLabel", {
          kind: tEntity(sel.entityKind),
          title: sel.title,
        })
      }
    }
  }

  // The badge disambiguates WHICH ARTIFACT receives the proposal, so it earns
  // its place only when more than one artifact is staged. One artifact beside
  // three files is unambiguous — the badge would just be noise.
  const artifactCount = selections.filter((sel) => sel.kind === "artifact").length
  const showEditTarget = artifactCount > 1
  const targetIndex = selections.findIndex((sel) => sel.kind === "artifact")

  const chips = (
    <>
      {selections.map((sel, index) => {
        const label = labelFor(sel)
        const isTarget = index === targetIndex
        const Icon = KIND_ICONS[sel.kind]
        const canPromote = showEditTarget && sel.kind === "artifact" && !isTarget
        // Only a message reference has neighbours to reach for, and only until
        // the span hits its ceiling — past that the control would promise a
        // widening that `clampSpan` refuses.
        // Recorded on the selection by the freshness pass above, not computed
        // here: the check is asynchronous and this render is not.
        const isStale = sel.kind === "entity" && Boolean(sel.stale)
        // An excerpt is text inside a message, and a span counts whole turns.
        // A combined reference has no one anchor to widen around.
        const isMessageSet = isMessageSetReference(sel)
        const canWiden =
          sel.kind === "entity" &&
          sel.entityKind === "message" &&
          !sel.excerpt &&
          !isMessageSet &&
          (sel.span?.before ?? 0) < MAX_MESSAGE_SPAN
        return (
          <div
            key={contextSelectionIdentity(sel)}
            data-testid="artifact-selection-chip"
            data-selection-kind={sel.kind}
            data-edit-target={showEditTarget && isTarget ? "true" : undefined}
            className={cn(
              "group flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs",
              showEditTarget && isTarget && "border-primary/50"
            )}
            title={isStale ? t("selectionStaleHint") : sel.comment || label}
            data-stale={isStale ? "true" : undefined}
          >
            <Icon className="size-3.5 text-muted-foreground" />
            {canPromote ? (
              <button
                type="button"
                data-testid="artifact-selection-promote"
                aria-label={t("promoteSelectionAria", { title: sel.title })}
                onClick={() => promote(index, composerSessionId)}
                className="max-w-[min(280px,calc(100vw-6rem))] truncate hover:underline"
              >
                {label}
              </button>
            ) : (
              <span className="max-w-[min(280px,calc(100vw-6rem))] truncate">{label}</span>
            )}
            {isStale ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="context-selection-refresh"
                aria-label={t("refreshSelectionAria", { title: sel.title })}
                title={t("refreshSelectionHint")}
                onClick={() => void refresh(index, sel)}
                className="size-5 text-amber-600 opacity-80 transition-opacity hover:opacity-100 dark:text-amber-400"
              >
                <RefreshCwIcon className="size-3" />
              </Button>
            ) : null}
            {isMessageSet && sel.kind === "entity" ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="context-selection-members"
                    aria-label={t("selectionMembersAria", { title: label })}
                    title={t("selectionMembersHint")}
                    className="size-5 opacity-60 transition-opacity hover:opacity-100"
                  >
                    <ListIcon className="size-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-[min(92vw,320px)] p-1"
                  data-testid="context-selection-member-list"
                >
                  <ul className="max-h-64 overflow-y-auto">
                    {(sel.members ?? []).map((member) => (
                      <li
                        key={member.entityId}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-muted/60"
                      >
                        <span className="min-w-0 flex-1 truncate" title={member.title}>
                          {member.title}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("selectionMemberRemoveAria", { title: member.title })}
                          onClick={() => void removeMember(index, sel, member.entityId)}
                          className="size-5 shrink-0 opacity-60 transition-opacity hover:opacity-100"
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            ) : null}
            {canWiden ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="context-selection-widen"
                aria-label={t("widenSelectionAria", { title: sel.title })}
                title={t("widenSelectionHint")}
                onClick={() => void widen(index, sel)}
                className="size-5 opacity-60 transition-opacity hover:opacity-100"
              >
                <ChevronsUpDownIcon className="size-3" />
              </Button>
            ) : null}
            {showEditTarget && isTarget ? (
              <Badge
                variant="secondary"
                className="shrink-0 px-1 text-[9px]"
                title={t("editTargetHint")}
              >
                {t("editTargetBadge")}
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("removeSelectionAria", { title: sel.title })}
              onClick={() => remove(index, composerSessionId)}
              className="size-5 opacity-60 transition-opacity hover:opacity-100"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )
      })}
    </>
  )

  if (bare) return chips
  return <div className="flex flex-wrap gap-1.5 px-2 pt-2">{chips}</div>
}
