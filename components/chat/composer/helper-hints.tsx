"use client"

// Tiny chip row at the very bottom of the composer reminding the user of
// the most useful shortcuts.

import { useTranslations } from "next-intl"
import { KeyboardIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useChatStore, useSessionHasMessages } from "@/stores/chat"

export interface HelperHintsProps {
  /**
   * Open the full shortcut cheatsheet. The sheet itself is mounted by the
   * composer, not here, so it stays reachable (via `?` on an empty input) long
   * after this onboarding row has retired.
   */
  onOpenCheatsheet?: () => void
}

// No `= {}` default on the parameter: it makes the whole parameter optional,
// which Storybook's `Meta<typeof HelperHints>` resolves to `never` args. Every
// field is optional, so `<HelperHints />` still type-checks.
export function HelperHints({ onOpenCheatsheet }: HelperHintsProps) {
  const t = useTranslations("chat.composer.helperHints")
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasMessages = useSessionHasMessages(activeSessionId)

  // Onboarding, not chrome. This used to render on every desktop turn — the
  // same three sentences under the composer, hundreds of times a day, for a
  // user who learned them on day one. Gated on the empty state instead: an
  // unstarted conversation is exactly when "press Enter to send" is news, and
  // the first reply retires it. The cheatsheet deliberately does NOT get a
  // permanent button here for the same reason — `?` keeps it reachable.
  if (hasMessages) return null

  return (
    // Stacked media + container variant: show only when BOTH the viewport is
    // ≥sm (keyboard hints are useless on touch) AND the composer container is
    // ≥@lg (a medium-width sidebar still uses the stacked composer and
    // shouldn't burn another row on hint chips).
    <div className="mt-1.5 hidden sm:@lg/composer:flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
      <Hint>{t("send")}</Hint>
      <Hint>{t("dropImages")}</Hint>
      <Hint>
        {t("tryPrefix")} <code className="font-mono">/</code> <code className="font-mono">@</code>{" "}
        <code className="font-mono">!</code> <code className="font-mono">#</code>
      </Hint>
      {onOpenCheatsheet ? (
        <button
          type="button"
          onClick={onOpenCheatsheet}
          data-testid="composer-cheatsheet-trigger"
          className="flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-[10px] underline-offset-2 hover:underline"
        >
          <KeyboardIcon className="size-3" aria-hidden />
          {t("cheatsheetLabel")}
        </button>
      ) : null}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="outline" className="rounded-full bg-background/60 px-2 py-0.5 text-[10px]">
      {children}
    </Badge>
  )
}
