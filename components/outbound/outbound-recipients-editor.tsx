"use client"

/**
 * A recipient list a person writes: who a Bot or a bot account may reach with
 * nobody watching (ADR-0239 `policy` grants).
 *
 * Only a person edits this, so the editor stores what they picked in the
 * engine's normalized form (`conversationTarget` / `personTarget` /
 * `mailTarget` / `repositoryTarget`) and nothing a model said. Conversations
 * are offered from the chats this device knows, by name, and repositories from
 * the ones it works with (ADR-0239 phase 2); a key or an `owner/repo` can
 * still be typed for one that never reached this device. Every add and remove
 * saves the whole list, so what is shown is what is stored.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { KnownConversation } from "@/hooks/outbound/use-known-conversations"
import type { KnownRepository } from "@/hooks/outbound/use-known-repositories"
import { listsRecipient, recipientGrant } from "@/lib/policy/action-review/configured-grants"
import {
  conversationTarget,
  mailTarget,
  outboundRecipientId,
  personTarget,
  repositoryOnHost,
  siteTarget,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"
import { cn } from "@/lib/utils"
import type {
  OutboundRecipientGrant,
  OutboundRecipientKind,
} from "@cognia/agent-config-types/action-review"

/** How many known conversations or repositories to offer at once. */
const SUGGESTION_LIMIT = 8

export interface OutboundRecipientsEditorProps {
  value: readonly OutboundRecipientGrant[]
  /** Save the whole list. Resolves false when the write was refused. */
  onSave: (next: OutboundRecipientGrant[]) => Promise<boolean>
  /** The kinds this list may hold, in the order the picker offers them. */
  kinds: readonly OutboundRecipientKind[]
  /**
   * The bot account every entry goes through, for a connector instance's list.
   * Members are named within it, and only its chats are offered or accepted.
   */
  adapterId?: string
  /** The chats this device knows, for picking by name. */
  knownConversations: readonly KnownConversation[]
  /** The repositories this device knows, for picking. */
  knownRepositories?: readonly KnownRepository[]
  /**
   * The web host a typed `owner/repo` is on: the account's, for an
   * integration account's list. Default github.com.
   */
  repositoryHost?: string
  disabled?: boolean
  testId?: string
}

type AddError = "invalid" | "duplicate" | "otherAccount"

export function OutboundRecipientsEditor({
  value,
  onSave,
  kinds,
  adapterId,
  knownConversations,
  knownRepositories = [],
  repositoryHost,
  disabled = false,
  testId = "outbound-recipients",
}: OutboundRecipientsEditorProps) {
  const t = useTranslations("outboundRecipients")
  const [kind, setKind] = useState<OutboundRecipientKind>(kinds[0] ?? "conversation")
  const [text, setText] = useState("")
  const [error, setError] = useState<AddError | null>(null)
  const [saving, setSaving] = useState(false)
  const locked = disabled || saving

  const titles = useMemo(
    () => new Map(knownConversations.map((known) => [known.target.recipient, known.title])),
    [knownConversations]
  )

  const suggestions = useMemo((): { target: OutboundTarget; title: string }[] => {
    const query = text.trim().toLowerCase()
    const candidates =
      kind === "conversation"
        ? knownConversations
            .filter((known) => !adapterId || known.target.channel === adapterId)
            .map((known) => ({ target: known.target, title: known.title }))
        : kind === "repository"
          ? knownRepositories.map((known) => ({ target: known.target, title: known.name }))
          : []
    return candidates
      .filter((known) => !listsRecipient(value, known.target))
      .filter((known) => !query || known.title.toLowerCase().includes(query))
      .slice(0, SUGGESTION_LIMIT)
  }, [adapterId, kind, knownConversations, knownRepositories, text, value])

  async function save(next: OutboundRecipientGrant[]): Promise<boolean> {
    setSaving(true)
    try {
      return await onSave(next)
    } finally {
      setSaving(false)
    }
  }

  function targetFromText(): OutboundTarget | undefined {
    const raw = text.trim()
    switch (kind) {
      case "conversation":
        return conversationTarget(raw)
      case "person":
        return adapterId ? personTarget(adapterId, raw) : undefined
      case "mail":
        return mailTarget(raw)
      case "repository":
        return repositoryOnHost(raw, repositoryHost)
      case "site":
        return siteTarget(raw)
    }
  }

  async function add(target: OutboundTarget | undefined) {
    const grant = target ? recipientGrant(target) : undefined
    if (!target || !grant) return setError("invalid")
    if (adapterId && target.channel !== adapterId) return setError("otherAccount")
    if (listsRecipient(value, target)) return setError("duplicate")
    setError(null)
    if (await save([...value, grant])) setText("")
  }

  async function remove(entry: OutboundRecipientGrant) {
    await save(value.filter((grant) => !listsRecipient([grant], entry.recipient)))
  }

  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid={`${testId}-list`}>
          {value.map((entry) => {
            const name =
              titles.get(entry.recipient.recipient) ?? outboundRecipientId(entry.recipient)
            return (
              <li
                key={`${entry.recipient.channel}|${entry.recipient.recipient}`}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
              >
                <Badge variant="outline" className="shrink-0 font-normal">
                  {t(`kind.${entry.recipient.kind}`)}
                </Badge>
                <span className="min-w-0 flex-1 truncate" title={entry.recipient.recipient}>
                  {name}
                </span>
                {(entry.recipient.kind === "conversation" || entry.recipient.kind === "person") &&
                !adapterId ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("via", { account: entry.recipient.channel })}
                  </span>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0"
                  disabled={locked}
                  aria-label={t("remove", { name })}
                  onClick={() => void remove(entry)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {kinds.length > 1 ? (
        <div className="flex gap-1" role="group" aria-label={t("kindLabel")}>
          {kinds.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={option === kind ? "secondary" : "ghost"}
              aria-pressed={option === kind}
              disabled={locked}
              onClick={() => {
                setKind(option)
                setError(null)
              }}
            >
              {t(`kind.${option}`)}
            </Button>
          ))}
        </div>
      ) : null}

      <form
        className="flex items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void add(targetFromText())
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setError(null)
            }}
            placeholder={t(`placeholder.${kind}`)}
            aria-label={t(`placeholder.${kind}`)}
            aria-invalid={error ? true : undefined}
            disabled={locked}
            className="h-8 text-sm"
          />
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error === "invalid" ? t(`invalid.${kind}`) : t(error)}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="sm" disabled={locked || !text.trim()}>
          {t("add")}
        </Button>
      </form>

      {kind === "conversation" || kind === "repository" ? (
        suggestions.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              {kind === "repository" ? t("knownRepository") : t("known")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((known) => (
                <Button
                  key={known.target.recipient}
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn("h-7 max-w-full gap-1 font-normal")}
                  disabled={locked}
                  aria-label={t("addNamed", { name: known.title })}
                  onClick={() => void add(known.target)}
                >
                  <PlusIcon className="size-3" />
                  <span className="truncate">{known.title}</span>
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {kind === "repository" ? t("noneKnownRepository") : t("noneKnown")}
          </p>
        )
      ) : null}
    </div>
  )
}
