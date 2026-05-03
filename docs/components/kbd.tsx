import type { ReactNode } from "react"

type Props = {
  /** Comma- or plus-separated chord, e.g. "Cmd+K" or "Ctrl+Shift+P". */
  keys?: string
  children?: ReactNode
}

function splitChord(s: string): string[] {
  return s
    .split(/\s*\+\s*/)
    .map((k) => k.trim())
    .filter(Boolean)
}

export function Kbd({ keys, children }: Props) {
  const parts = typeof children === "string" ? splitChord(children) : keys ? splitChord(keys) : []

  if (parts.length === 0) {
    return (
      <kbd className="not-prose rounded-md border border-fd-border bg-fd-card px-1.5 py-0.5 font-mono text-xs">
        {children}
      </kbd>
    )
  }

  return (
    <span className="not-prose inline-flex items-center gap-1 align-middle">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
          <kbd className="rounded-md border border-fd-border bg-fd-card px-1.5 py-0.5 font-mono text-xs shadow-sm">
            {part}
          </kbd>
          {i < parts.length - 1 ? (
            <span className="text-xs text-fd-muted-foreground">+</span>
          ) : null}
        </span>
      ))}
    </span>
  )
}
