"use client"

/**
 * What an app-table task runs (the payload), in the detail.
 *
 * The facts come from `summarizeTaskPayload`; this component only renders
 * them and turns the ids a payload stores (a character, a workflow, a plan,
 * a team, an external agent, a session) into the names a person recognises.
 * A reference the lookup cannot find says so instead of showing a bare id
 * that reads as if it resolved: "this task points at a workflow you deleted"
 * is exactly what someone opening a failing task needs to learn.
 *
 * Short facts sit in the fact grid; prose and code (a prompt, a command, the
 * workflow inputs) get the full width, clamped with a toggle, because a
 * prompt squeezed into a third of a card is unreadable and an unclamped one
 * pushes the runs off the screen. The stored payload is one click away for
 * anything the summary does not read.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { FactList, FactRow } from "@/components/surface/fact-list"
import { useCopy } from "@/hooks/ui/use-copy"
import { formatDuration } from "@/lib/scheduler/format-utils"
import {
  summarizeTaskPayload,
  type PayloadFact,
  type PayloadReferenceKind,
} from "@/lib/scheduler/payload-summary"
import { cn } from "@/lib/utils"
import type { ScheduledTask } from "@/types/scheduler"

/** Resolves a referenced record to its display name; `null` when it no longer exists. */
export type PayloadReferenceResolver = (
  ref: PayloadReferenceKind,
  id: string
) => Promise<string | null>

/**
 * The lookups the payload editors use to fill their pickers, one record at a
 * time. Imported lazily: the detail of a backup task should not load the team
 * manager.
 */
export const resolvePayloadReference: PayloadReferenceResolver = async (ref, id) => {
  switch (ref) {
    case "character": {
      const { resolveCharacterById } = await import("@/lib/db/characters")
      return (await resolveCharacterById(id))?.name ?? null
    }
    case "skill": {
      const { getSkill } = await import("@/lib/db/skills")
      return (await getSkill(id))?.name ?? null
    }
    case "workflow": {
      const { getDb } = await import("@/lib/db/schema")
      const row = await getDb().workflows.get(id)
      return row ? row.name || row.id : null
    }
    case "plan": {
      const { getPlan } = await import("@/lib/db/plans")
      return (await getPlan(id))?.title ?? null
    }
    case "session": {
      const { getSession } = await import("@/lib/db/sessions")
      const session = await getSession(id)
      return session ? session.title || session.id : null
    }
    case "team": {
      const { agentTeamManager } = await import("@/lib/ai/agent/team/agent-team")
      return agentTeamManager.get(id)?.name ?? null
    }
    case "externalAgent": {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      try {
        return getExternalAgentManager().getAgent(id)?.config.name ?? null
      } catch {
        // The manager is not initialised on this host yet; the id is all there is.
        return null
      }
    }
  }
}

/** Facts that need the card's width: prose, code and structured data. */
function isWide(fact: PayloadFact): boolean {
  const { value } = fact
  if (value.kind === "multiline" || value.kind === "json") return true
  // A command or a script body is code, and wraps badly in a third of a card.
  return value.kind === "mono" && (fact.id === "command" || fact.id === "code")
}

/** Lines a wide block shows before its toggle. */
const CLAMP_LINES = 6

type ResolvedNames = Record<string, string | null>

function referenceKey(ref: PayloadReferenceKind, id: string): string {
  return `${ref}:${id}`
}

export interface PayloadSectionProps {
  task: Pick<ScheduledTask, "id" | "type" | "payload">
  /** Test seam; defaults to {@link resolvePayloadReference}. */
  resolveReference?: PayloadReferenceResolver
  className?: string
}

export function PayloadSection({
  task,
  resolveReference = resolvePayloadReference,
  className,
}: PayloadSectionProps) {
  const t = useTranslations("scheduler")
  const summary = useMemo(() => summarizeTaskPayload(task), [task])
  const references = useMemo(
    () =>
      summary.facts.flatMap((fact) =>
        fact.value.kind === "reference" ? [{ ref: fact.value.ref, id: fact.value.id }] : []
      ),
    [summary]
  )
  const referencesKey = references.map(({ ref, id }) => referenceKey(ref, id)).join("|")
  const [names, setNames] = useState<{ key: string; names: ResolvedNames }>({
    key: "",
    names: {},
  })

  useEffect(() => {
    if (references.length === 0) return
    let cancelled = false
    void Promise.all(
      references.map(async ({ ref, id }) => {
        const name = await resolveReference(ref, id).catch(() => null)
        return [referenceKey(ref, id), name] as const
      })
    ).then((entries) => {
      if (!cancelled) setNames({ key: referencesKey, names: Object.fromEntries(entries) })
    })
    return () => {
      cancelled = true
    }
    // `referencesKey` names the set; `references` is rebuilt with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencesKey, resolveReference])

  // Names resolved for a previous task must not label this one's ids.
  const resolved = names.key === referencesKey ? names.names : {}
  const typeLabel = t.has(`taskTypes.${task.type}`) ? t(`taskTypes.${task.type}`) : task.type
  const shortFacts = summary.facts.filter((fact) => !isWide(fact))
  const wideFacts = summary.facts.filter(isWide)

  const renderValue = (fact: PayloadFact): React.ReactNode => {
    const { value } = fact
    switch (value.kind) {
      case "text":
      case "mono":
      case "multiline":
        return value.text
      case "label":
        return t(value.key)
      case "boolean":
        return value.value ? t("yes") : t("no")
      case "duration":
        return formatDuration(value.ms)
      case "date":
        return new Date(value.at).toLocaleString()
      case "count":
        return String(value.value)
      case "list":
        return value.items.join(", ")
      case "json":
        return JSON.stringify(value.value, null, 2)
      case "reference": {
        const name = resolved[referenceKey(value.ref, value.id)]
        if (name === undefined) {
          return <span className="font-mono text-[11px] text-muted-foreground">{value.id}</span>
        }
        if (name === null) {
          return (
            <span className="text-amber-600 dark:text-amber-400" data-testid="payload-missing-ref">
              {t("payloadSummary.missingReference", { id: value.id })}
            </span>
          )
        }
        return (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
            {value.ref === "workflow" ? (
              <Link
                href={`/workflows/editor?id=${encodeURIComponent(value.id)}`}
                className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                data-testid="payload-workflow-link"
              >
                {name}
                <ArrowUpRightIcon className="size-3" aria-hidden="true" />
              </Link>
            ) : (
              <span>{name}</span>
            )}
            <span className="font-mono text-[10px] font-normal text-muted-foreground">
              {value.id}
            </span>
          </span>
        )
      }
    }
  }

  return (
    <div className={cn("space-y-3", className)} data-testid="payload-section">
      <FactList>
        <FactRow label={t("taskType")}>{typeLabel}</FactRow>
        {shortFacts.map((fact) => (
          <FactRow
            key={fact.id}
            label={t(fact.label)}
            mono={fact.value.kind === "mono" || (fact.value.kind === "list" && fact.value.mono)}
          >
            <span data-testid={`payload-fact-${fact.id}`}>{renderValue(fact)}</span>
          </FactRow>
        ))}
      </FactList>

      {wideFacts.map((fact) => (
        <WideFact
          key={fact.id}
          id={fact.id}
          label={t(fact.label)}
          text={String(renderValue(fact))}
          code={fact.value.kind !== "multiline"}
        />
      ))}

      {summary.facts.length === 0 && !summary.raw ? (
        <p className="text-xs text-muted-foreground" data-testid="payload-empty">
          {t("payloadSummary.empty")}
        </p>
      ) : null}

      {summary.raw ? <RawPayload raw={summary.raw} /> : null}
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("scheduler.payloadSummary")
  const { copied, copy } = useCopy()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-6 text-muted-foreground"
      onClick={() => void copy(value)}
      aria-label={copied ? t("copied") : t("copy", { label })}
      data-testid="payload-copy"
    >
      {copied ? (
        <CheckIcon className="size-3" aria-hidden="true" />
      ) : (
        <CopyIcon className="size-3" aria-hidden="true" />
      )}
    </Button>
  )
}

function WideFact({
  id,
  label,
  text,
  code,
}: {
  id: string
  label: string
  text: string
  code: boolean
}) {
  const t = useTranslations("scheduler")
  const [expanded, setExpanded] = useState(false)
  const lineCount = text.split("\n").length
  // A long single line wraps to many; count characters too, roughly a line each 80.
  const clampable = lineCount > CLAMP_LINES || text.length > CLAMP_LINES * 80

  return (
    <div className="min-w-0" data-testid={`payload-fact-${id}`}>
      <div className="flex items-center gap-1">
        <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
        <span className="ml-auto">
          <CopyButton value={text} label={label} />
        </span>
      </div>
      <div
        className={cn(
          "mt-1 rounded-md border bg-muted/40 px-2.5 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap",
          code && "font-mono text-[11px]",
          clampable && !expanded && "line-clamp-6"
        )}
        data-testid={`payload-fact-${id}-body`}
      >
        {text}
      </div>
      {clampable ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-[11px]"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          data-testid={`payload-fact-${id}-toggle`}
        >
          {expanded ? t("showLess") : t("showMore")}
        </Button>
      ) : null}
    </div>
  )
}

function RawPayload({ raw }: { raw: Record<string, unknown> }) {
  const t = useTranslations("scheduler.payloadSummary")
  const json = useMemo(() => JSON.stringify(raw, null, 2), [raw])
  return (
    <Collapsible>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group/raw -ml-2 h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            data-testid="payload-raw-toggle"
          >
            <ChevronDownIcon
              className="size-3 transition-transform group-data-[state=closed]/raw:-rotate-90"
              aria-hidden="true"
            />
            {t("raw")}
          </Button>
        </CollapsibleTrigger>
        <span className="ml-auto">
          <CopyButton value={json} label={t("raw")} />
        </span>
      </div>
      <CollapsibleContent>
        <pre
          className="mt-1 max-h-72 overflow-auto rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed"
          data-testid="payload-raw"
        >
          {json}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
