"use client"

import { useEffect, useRef } from "react"
import { usePluginT } from "../use-plugin-t"

export function ScanConsole({ text }: { text: string }) {
  const t = usePluginT()
  const ref = useRef<HTMLPreElement>(null)

  // Keep the newest output in view as it streams.
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        {t("console.title")}
      </h3>
      {text ? (
        <pre
          ref={ref}
          className="min-h-24 flex-1 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed"
          data-testid="strix-console"
        >
          {text}
        </pre>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t("console.empty")}
        </div>
      )}
    </div>
  )
}
