// The egg's half of the nurture tab: the egg and a "Hatch" button.
//
// Hatching runs a model call that can take several seconds, and the button
// used to stay live through it with nothing on screen: a second click started
// a second soul generation, and a failure vanished. The button now shows its
// pending state, and every outcome other than a fresh hatch is told to the
// user by the console's actions (`PetConsoleActions.hatch`), which resolve to
// an outcome rather than throwing. Locally `hatchPetOnce` shares one run
// between callers, and on a paired phone the desktop does, so the guard here
// is about feedback, not the only line of defense.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import type { PetActionOutcome } from "@/lib/pet/console/outcome-messages"
import type { PetBones, PetSkinSelection } from "@/types/pet"
import { PetRenderer } from "../pet-renderer"

export interface HatchPanelProps {
  bones: PetBones
  skinId?: string
  selection?: PetSkinSelection
  /** Resolves once the hatch settled; the outcome has already been told. */
  onHatch: () => Promise<PetActionOutcome>
  lowPower?: boolean
}

export function HatchPanel({ bones, skinId, selection, onHatch, lowPower }: HatchPanelProps) {
  const t = useTranslations("pet")
  const [pending, setPending] = useState(false)

  const hatch = async () => {
    if (pending) return
    setPending(true)
    try {
      await onHatch()
    } catch {
      // The console's actions never throw; an action that does (a bug, or a
      // story's stub) still must not leave a click unanswered.
      toast.error(t("console.hatchFailed"))
    } finally {
      // Whatever happened, the button must not stay spinning.
      setPending(false)
    }
  }

  return (
    <Empty data-testid="pet-hatch" className="py-8">
      <EmptyHeader>
        <EmptyMedia>
          <PetRenderer
            bones={bones}
            stage="egg"
            state="idle"
            size={120}
            skinId={skinId}
            selection={selection}
            renderPriority="console"
            lowPower={lowPower}
          />
        </EmptyMedia>
        <EmptyDescription>
          {pending ? t("console.hatching") : t("console.hatchPrompt")}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          className="min-h-11"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void hatch()}
        >
          {pending ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : null}
          {t("console.hatch")}
        </Button>
      </EmptyContent>
    </Empty>
  )
}
