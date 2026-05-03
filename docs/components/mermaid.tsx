"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTheme } from "next-themes"

type MermaidProps = {
  chart: string
}

export function Mermaid({ chart }: MermaidProps) {
  const id = useId().replace(/:/g, "")
  const containerRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const { resolvedTheme } = useTheme()

  // Standard "client-side hydration" gate — flip to `true` once on mount so
  // the server-rendered output stays untouched and dynamic-import + render
  // happen only on the client.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!mounted || !containerRef.current) return
    let cancelled = false

    void (async () => {
      const mermaid = (await import("mermaid")).default
      mermaid.initialize({
        startOnLoad: false,
        theme: resolvedTheme === "dark" ? "dark" : "default",
        securityLevel: "loose",
        themeVariables: {
          fontFamily: "var(--font-geist-sans, system-ui, sans-serif)",
        },
      })
      try {
        const renderId = `mermaid-${id}`
        const { svg } = await mermaid.render(renderId, chart)
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg
        }
      } catch (err) {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = `<pre style="color: var(--color-fd-destructive, #ef4444); white-space: pre-wrap; font-size: 0.875rem;">Mermaid render error:\n${
            err instanceof Error ? err.message : String(err)
          }</pre>`
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [chart, id, mounted, resolvedTheme])

  return (
    <div
      ref={containerRef}
      className="my-6 flex justify-center overflow-x-auto rounded-lg border border-fd-border bg-fd-card p-4 [&_svg]:max-w-full"
    />
  )
}
