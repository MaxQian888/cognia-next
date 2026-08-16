"use client"

import { FolderTreeIcon, GlobeIcon, Loader2Icon, ScanTextIcon, type LucideIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import type { Character, OnboardingShell } from "@cognia/agent-config-types"

import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Button } from "@/components/ui/button"
import { StepHeading } from "../step-shell"
import { starterCardsWithFallback, type StarterCard } from "@/lib/onboarding/starter-cards"
import type { OnboardingCapability } from "@/lib/onboarding/scan"

const CARD_ICONS: Record<StarterCard["icon"], LucideIcon> = {
  folder: FolderTreeIcon,
  "scan-text": ScanTextIcon,
  globe: GlobeIcon,
}

interface FirstRunStepProps {
  shell: OnboardingShell
  capabilities: readonly OnboardingCapability[]
  /** Preselected persona. `null` while the builtin-characters plugin seeds. */
  character: Character | null
  onChangeCharacter: () => void
  /** Runs the card: opens a session, sends its fixed prompt, and lands there. */
  onPick: (card: StarterCard) => Promise<void>
  /** Label of the runtime that will execute, so it is never a mystery. */
  runtimeLabel?: string
}

/**
 * Step 3 — the terminal state: one real, locally-verifiable piece of work.
 *
 * This is what the whole flow exists to reach. Its predecessor ended on a
 * six-slide carousel and an empty chat box, so a user finished setup having
 * never seen the product do anything.
 *
 * **Cards are hidden, not disabled, when their capability is missing** — see
 * `availableStarterCards`. A greyed-out card still advertises something the
 * user cannot do, which is precisely the old tour's failure.
 *
 * **The character picker is folded in here rather than given its own screen**
 * (it had one in the old dialog). Choosing a persona means something at the
 * moment you are about to put it to work, and nothing at all before that. It
 * renders only once a character is available: the builtin set is seeded by a
 * plugin, so on a genuine first run this can briefly be `null`, and showing an
 * empty picker would be worse than showing none.
 */
export function FirstRunStep({
  shell,
  capabilities,
  character,
  onChangeCharacter,
  onPick,
  runtimeLabel,
}: FirstRunStepProps) {
  const t = useTranslations("onboarding")
  const [running, setRunning] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const cards = starterCardsWithFallback({ shell, capabilities })

  const pick = async (card: StarterCard) => {
    if (running) return
    setRunning(card.id)
    setFailed(false)
    try {
      await onPick(card)
    } catch {
      setFailed(true)
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="onboarding-first-run">
      <StepHeading title={t("firstRun.title")} description={t("firstRun.description")} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {cards.map((card) => {
          const Icon = CARD_ICONS[card.icon]
          return (
            <Button
              key={card.id}
              type="button"
              variant="outline"
              disabled={running !== null}
              onClick={() => void pick(card)}
              data-testid={`onboarding-card-${card.id}`}
              className="h-full w-full flex-col items-stretch justify-start gap-2 whitespace-normal p-4 text-left font-normal hover:border-primary/30 hover:shadow-md motion-safe:hover:-translate-y-0.5"
            >
              <span className="flex items-center gap-2">
                {running === card.id ? (
                  <Loader2Icon className="size-4 animate-spin text-primary" aria-hidden />
                ) : (
                  <Icon className="size-4 text-primary" aria-hidden />
                )}
                <span className="text-sm font-medium">{t(`cards.${card.key}.title`)}</span>
              </span>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                {t(`cards.${card.key}.description`)}
              </span>
            </Button>
          )
        })}
      </div>

      {failed && (
        <p
          className="text-sm text-destructive"
          role="alert"
          data-testid="onboarding-first-run-failed"
        >
          {t("firstRun.failed")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t pt-4 text-xs text-muted-foreground">
        {character && (
          <span className="flex items-center gap-2" data-testid="onboarding-character">
            <AvatarBadge subject={character} size={24} textClassName="text-xs" />
            {t("firstRun.runningWith", { name: character.name })}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={onChangeCharacter}
              data-testid="onboarding-change-character"
            >
              {t("firstRun.changeCharacter")}
            </Button>
          </span>
        )}
        {runtimeLabel && <span>{t("firstRun.runtimeLine", { runtime: runtimeLabel })}</span>}
      </div>
    </div>
  )
}
