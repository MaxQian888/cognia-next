"use client"

import { FolderTreeIcon, GlobeIcon, ScanTextIcon, type LucideIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import type { Character, OnboardingShell } from "@cognia/agent-config-types"

import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StepHeading } from "../step-shell"
import { cn } from "@/lib/utils"
import { starterCardsWithFallback, type StarterCard } from "@/lib/onboarding/starter-cards"
import type { OnboardingCapability } from "@/lib/onboarding/scan"

/** Column count per available-card count. Tailwind needs literal class names. */
const CARD_GRID_COLUMNS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
}

const CARD_ICONS: Record<StarterCard["icon"], LucideIcon> = {
  folder: FolderTreeIcon,
  "scan-text": ScanTextIcon,
  globe: GlobeIcon,
}

interface FirstRunStepProps {
  shell: OnboardingShell
  capabilities: readonly OnboardingCapability[]
  /**
   * Whether this device can reach a model at all. `false` disables the cards:
   * running one creates a session, queues its prompt and records the flow as
   * completed, so without this the step reported success and handed the user a
   * turn that failed in the chat pane a moment later.
   *
   * A paired phone reports `null` — its credentials live on the desktop and it
   * has nothing local to probe — which reads as "no reason to block".
   */
  modelAccess: boolean | null
  /** Back to the sign-in step. Omitted when this shell has no such step. */
  onConnectModel?: () => void
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
  modelAccess,
  onConnectModel,
  character,
  onChangeCharacter,
  onPick,
  runtimeLabel,
}: FirstRunStepProps) {
  const t = useTranslations("onboarding")
  const [running, setRunning] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const cards = starterCardsWithFallback({ shell, capabilities })
  // Only a settled `false` blocks. `null` is "this shell cannot answer".
  const blocked = modelAccess === false

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

      {blocked && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-4 text-sm"
          role="status"
          data-testid="onboarding-first-run-blocked"
        >
          <span className="text-muted-foreground">{t("firstRun.needsModel")}</span>
          {onConnectModel && (
            <Button
              variant="outline"
              size="sm"
              onClick={onConnectModel}
              data-testid="onboarding-first-run-connect"
            >
              {t("firstRun.connectCta")}
            </Button>
          )}
        </div>
      )}

      {/* Static class names, so the column count has to be a lookup rather
          than interpolation. One available card stretched across a third of
          the row read as a layout bug; a browser only ever gets one. */}
      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          CARD_GRID_COLUMNS[cards.length] ?? "sm:grid-cols-3"
        )}
      >
        {cards.map((card) => {
          const Icon = CARD_ICONS[card.icon]
          return (
            <button
              key={card.id}
              type="button"
              disabled={running !== null || blocked}
              onClick={() => void pick(card)}
              data-testid={`onboarding-card-${card.id}`}
              className="flex h-full w-full flex-col items-stretch gap-2 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-safe:hover:-translate-y-0.5"
            >
              <span className="flex items-center gap-2">
                {running === card.id ? (
                  <Spinner className="size-4 text-primary" />
                ) : (
                  <Icon className="size-4 text-primary" aria-hidden />
                )}
                <span className="text-sm font-medium">{t(`cards.${card.key}.title`)}</span>
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {t(`cards.${card.key}.description`)}
              </span>
            </button>
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

      {/* Only when it has something to say — an empty row still painted its
          top border, leaving a hairline under the grid with nothing beneath. */}
      {(character || runtimeLabel) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-5 text-xs text-muted-foreground">
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
      )}
    </div>
  )
}
