"use client"

// Tiny chip row at the very bottom of the composer reminding the user of
// the most useful shortcuts. Kept terse to avoid stealing attention.

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"

export function HelperHints() {
  const t = useTranslations("chat.composer.helperHints")
  return (
    <div className="mt-1.5 hidden sm:flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
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
