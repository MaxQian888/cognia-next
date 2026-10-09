"use client"

/**
 * The agents console's centre when no agent is open, and the "New agent" landing
 * (ADR-0220): the two ways to make an agent — fill in the form, or describe it
 * and let a builder conversation fill it in — and every unfinished builder
 * draft, so a draft is never silently abandoned.
 *
 * Drawn the way Cognia's other consoles draw an empty centre (the Squad fleet's
 * onboarding): the spot illustration, one line of why, then the actions. The
 * two ways are rows with a sentence each rather than two bare buttons, because
 * the difference between them is the whole decision.
 */

import { useTranslations } from "next-intl"
import { ChevronRightIcon, PencilLineIcon, SparklesIcon } from "lucide-react"
import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { AgentBuilderDrafts } from "../builder/agent-builder-drafts"

export interface AgentCreateChooserProps {
  /**
   * `home`: nothing is selected, so the copy invites picking an agent from the
   * list as well as making one. `create`: the person asked to make an agent.
   */
  mode?: "home" | "create"
  /** How many agents exist; the home copy differs for an empty workspace. */
  agentCount?: number
  onBlank: () => void
  onBuildWithAi: () => void
  onResumeDraft: (sessionId: string) => void
  className?: string
}

export function AgentCreateChooser({
  mode = "create",
  agentCount = 0,
  onBlank,
  onBuildWithAi,
  onResumeDraft,
  className,
}: AgentCreateChooserProps) {
  const t = useTranslations("agentsConsole.chooser")
  const title =
    mode === "create" ? t("createTitle") : agentCount > 0 ? t("homeTitle") : t("emptyTitle")
  const description =
    mode === "create"
      ? t("createDescription")
      : agentCount > 0
        ? t("homeDescription", { count: agentCount })
        : t("emptyDescription")

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col overflow-y-auto", className)}
      data-testid="agent-create-chooser"
      data-mode={mode}
    >
      <div className="m-auto flex w-full max-w-md flex-col items-center px-6 py-10 text-center">
        <MobileSpotIcon name="characters" size={96} />
        <h2 className="mt-3 text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <div className="mt-6 w-full space-y-2 text-left">
          <ChoiceRow
            icon={SparklesIcon}
            title={t("aiTitle")}
            description={t("aiDescription")}
            badge={t("recommended")}
            onSelect={onBuildWithAi}
            testId="agent-create-ai"
          />
          <ChoiceRow
            icon={PencilLineIcon}
            title={t("blankTitle")}
            description={t("blankDescription")}
            onSelect={onBlank}
            testId="agent-create-blank"
          />
        </div>
        <AgentBuilderDrafts onResume={onResumeDraft} className="mt-6 w-full text-left" />
      </div>
    </div>
  )
}

function ChoiceRow({
  icon: Icon,
  title,
  description,
  badge,
  onSelect,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  badge?: string
  onSelect: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className="group flex w-full items-center gap-3 rounded-lg border text-left bg-background px-3.5 py-3 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {badge ? (
            <Badge variant="secondary" className="px-1.5 text-[10px] font-normal">
              {badge}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRightIcon
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </button>
  )
}
