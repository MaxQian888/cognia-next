"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react"
import type { ToolUIPart } from "ai"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { getDb } from "@/lib/db/schema"
import { revealSpawnedTask } from "@/lib/tasks/spawn-task-dispatch"
import { McpCardShell, useParsedOutput } from "./common"

interface SpawnTaskOutput {
  ok?: boolean
  taskSessionId?: string
  title?: string
  tldr?: string
  situation?: string
  codeLocations?: string[]
  solution?: string
  caveats?: string[]
  mode?: "aside" | "inherit"
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1 py-1 text-left font-medium text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
          {label}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-2 pl-4 text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function SpawnTaskCard({ part, sessionId }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("chat.mcp.spawnTask")
  const output = useParsedOutput<SpawnTaskOutput>(part.output)
  const taskId = output?.taskSessionId
  const task = useLiveQuery(
    async () => (taskId ? await getDb().sessions.get(taskId) : undefined),
    [taskId]
  )
  if (!output?.ok || !taskId || !output.title || !output.tldr) return null

  const started = task?.lastMessageAt !== undefined
  const action = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={!sessionId}
      aria-label={t(started ? "open" : "start")}
      onClick={() => sessionId && revealSpawnedTask(sessionId, taskId)}
    >
      <ExternalLinkIcon className="size-3" />
      {t(started ? "open" : "start")}
    </Button>
  )

  return (
    <McpCardShell
      title={output.title}
      badge={output.mode === "inherit" ? t("inherit") : t("aside")}
      action={action}
      testId="mcp-spawn-task-card"
    >
      <p className="text-sm">{output.tldr}</p>
      {output.situation ? (
        <DetailSection label={t("situation")}>{output.situation}</DetailSection>
      ) : null}
      {output.codeLocations?.length ? (
        <DetailSection label={t("codeLocations")}>
          <ul className="space-y-0.5 font-mono">
            {output.codeLocations.map((location) => (
              <li key={location}>{location}</li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
      {output.solution ? (
        <DetailSection label={t("solution")}>{output.solution}</DetailSection>
      ) : null}
      {output.caveats?.length ? (
        <DetailSection label={t("caveats")}>
          <ul className="list-disc space-y-0.5 pl-4">
            {output.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
    </McpCardShell>
  )
}
