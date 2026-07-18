"use client"

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useLiveQuery } from "dexie-react-hooks"
import { ExternalLinkIcon } from "lucide-react"
import { getCharacter } from "@/lib/db/characters"
import { Button } from "@/components/ui/button"

const GOAL_TRACKER_ID = "char_builtin_goal_tracker"

/**
 * Settings → Goals → Tracker tab. Phase 1 surfaces the built-in Goal
 * Tracker character so the user can confirm it's installed and inspect
 * the canonical systemPrompt. Editing the character (model, custom
 * prompt, tools) is done via the regular Settings → Characters surface;
 * the button at the foot of the card deep-links there
 * (`/settings?section=characters`).
 */
export function GoalTrackerConfig() {
  const t = useTranslations("goal")
  const router = useRouter()
  // Map "not found" to `null` so we can distinguish loading (useLiveQuery
  // pre-emission → `undefined`) from a genuine missing-row state (→ `null`).
  const character = useLiveQuery(async () => {
    const row = await getCharacter(GOAL_TRACKER_ID)
    return row ?? null
  }, [])

  if (character === undefined)
    return <p className="text-sm text-muted-foreground">{t("tracker.loading")}</p>

  if (character === null) {
    return (
      <div
        className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
        data-testid="goal-tracker-missing"
      >
        {t("tracker.missing")}
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="goal-tracker-card">
      <div className="flex items-center gap-3">
        <span className="text-2xl" aria-hidden>
          {character.avatarEmoji ?? "🎯"}
        </span>
        <div>
          <h3 className="font-medium">{character.name}</h3>
          <p className="text-xs text-muted-foreground">{character.description}</p>
        </div>
      </div>
      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t("tracker.systemPrompt")}</summary>
        <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
          {character.systemPrompt}
        </pre>
      </details>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{t("tracker.permissionMode", { mode: character.permissionMode ?? "default" })}</span>
        <span>•</span>
        <span>{t("tracker.builtin")}</span>
      </div>
      <p className="text-xs text-muted-foreground">{t("tracker.customise")}</p>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => router.push("/settings?section=characters")}
        data-testid="goal-tracker-open-characters"
      >
        <ExternalLinkIcon className="size-4" aria-hidden />
        {t("tracker.openCharacters")}
      </Button>
    </div>
  )
}
