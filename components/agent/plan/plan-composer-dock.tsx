"use client"

/**
 * Self-hiding "author a plan yourself" affordance, mounted in the same
 * above-the-composer slot as {@link PlanApprovalDock} / {@link PlanTrackerDock}.
 *
 * Gating is deliberately narrow so this never becomes permanent chrome (the
 * chat header's own rule: ambient status that self-hides, or the single owner
 * of a frequent action). It appears only when BOTH hold:
 *
 *   - the session is in `plan` permission mode — the user is planning, so a
 *     hand-authored plan is a plausible next action; and
 *   - the session has no open plan — an existing draft / approval / run owns
 *     the slot, and the one-open-plan-per-session invariant would cancel it.
 *
 * The three docks are therefore mutually exclusive by construction.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PlanComposerDialog } from "./plan-composer-dialog"
import { useSessionPlan } from "@/hooks/agent/use-session-plan"
import { useChatStore } from "@/stores/chat"

export interface PlanComposerDockProps {
  sessionId: string
  /** Stamped onto the created plan for avatar continuity (same as capture). */
  characterId?: string
}

export function PlanComposerDock({ sessionId, characterId }: PlanComposerDockProps) {
  const t = useTranslations("plan.composer")
  const plan = useSessionPlan(sessionId)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const [open, setOpen] = useState(false)

  if (permissionMode !== "plan") return null
  if (plan) return null

  return (
    <div className="flex justify-end px-3 pb-1" data-testid="plan-composer-dock">
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground h-6 gap-1 text-[11px]"
        onClick={() => setOpen(true)}
        data-testid="plan-composer-open"
      >
        <PlusIcon className="size-3" />
        {t("openLabel")}
      </Button>
      <PlanComposerDialog
        sessionId={sessionId}
        characterId={characterId}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  )
}
