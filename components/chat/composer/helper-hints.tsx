"use client"

// Tiny chip row at the very bottom of the composer reminding the user of
// the most useful shortcuts.

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { useChatStore, useSessionHasMessages } from "@/stores/chat"

export function HelperHints() {
  const t = useTranslations("chat.composer.helperHints")
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const hasMessages = useSessionHasMessages(activeSessionId)

  // Onboarding, not chrome. This used to render on every desktop turn — the
  // same three sentences under the composer, hundreds of times a day, for a
  // user who learned them on day one. Gated on the empty state instead: an
  // unstarted conversation is exactly when "press Enter to send" is news, and
  // the first reply retires it.
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
