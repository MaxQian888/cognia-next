"use client"

/**
 * "Open what this run produced."
 *
 * A scheduled `agent` task that runs overnight writes a whole conversation.
 * The run row recorded which session it was from the beginning, and the detail
 * sheet rendered the executor output as a JSON blob, so the only way to reach
 * that conversation was to read an id out of the dump and go hunting. This is
 * the link that was missing.
 *
 * Derivation lives in `lib/scheduler/run-artifact-link.ts` and is pure. This
 * component only knows how to navigate.
 */

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowUpRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { runArtifactLinks, type RunArtifactLink } from "@/lib/scheduler/run-artifact-link"

export interface RunArtifactLinksProps {
  /** The run's recorded executor output. */
  output: unknown
  /** Injected in tests, so the suite does not need a chat store. */
  onOpenSession?: (sessionId: string) => void
}

/** Focus a session in the chat pane. */
async function focusSession(sessionId: string): Promise<void> {
  const { useChatStore } = await import("@/stores/chat")
  useChatStore.getState().setActiveSession(sessionId)
}

export function RunArtifactLinks({ output, onOpenSession }: RunArtifactLinksProps) {
  const t = useTranslations("scheduler")
  const router = useRouter()
  const links = runArtifactLinks(output)
  if (links.length === 0) return null

  const open = (link: RunArtifactLink) => {
    if (link.kind === "session") {
      // The chat pane is the root route, so focusing the session IS the
      // navigation. Push after, not before: routing first would render the
      // pane against whatever session was previously active.
      if (onOpenSession) onOpenSession(link.id)
      else void focusSession(link.id)
      router.push("/")
      return
    }
    if (link.href) router.push(link.href)
  }

  return (
    <section data-testid="run-artifact-links">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {t("runArtifacts.title")}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {links.map((link) => (
          <Button
            key={`${link.kind}:${link.id}`}
            type="button"
            variant="outline"
            size="xs"
            className="gap-1"
            onClick={() => open(link)}
            data-testid={`run-artifact-${link.kind}`}
          >
            {t(`runArtifacts.${link.kind}`)}
            <ArrowUpRight className="h-3 w-3" />
          </Button>
        ))}
      </div>
    </section>
  )
}
