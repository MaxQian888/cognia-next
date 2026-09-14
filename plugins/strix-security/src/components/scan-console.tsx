"use client"

import { useEffect, useRef } from "react"
import { usePluginT } from "../use-plugin-t"

interface Props {
  text: string
  /** True when the panel dropped the head of the stream to stay bounded. */
  truncated?: boolean
}

/** Within this many px of the bottom the console still counts as "pinned". */
const PIN_THRESHOLD_PX = 24

export function ScanConsole({ text, truncated = false }: Props) {
  const t = usePluginT()
  const ref = useRef<HTMLPreElement>(null)
  // Only auto-scroll while the reader is already at the bottom — yanking the
  // scroll back on every chunk makes it impossible to read earlier output
  // while a scan is still streaming.
  const pinnedRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        {t("console.title")}
      </h3>
      {text ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          {truncated && (
            <p className="text-xs text-muted-foreground" data-testid="strix-console-truncated">
              {t("console.truncated")}
            </p>
          )}
          <pre
            ref={ref}
            onScroll={(e) => {
              const el = e.currentTarget
              pinnedRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX
            }}
            className="min-h-24 flex-1 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed"
            data-testid="strix-console"
          >
            {text}
          </pre>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t("console.empty")}
        </div>
      )}
    </div>
  )
}
