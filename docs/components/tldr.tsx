import type { ReactNode } from "react"

type Props = {
  title?: string
  children: ReactNode
}

export function TLDR({ title = "TL;DR", children }: Props) {
  return (
    <aside className="my-6 rounded-lg border border-fd-border bg-gradient-to-br from-violet-500/10 via-fd-card to-sky-500/10 p-5 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fd-muted-foreground">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
        >
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
        </svg>
        {title}
      </div>
      <div className="text-sm leading-relaxed">{children}</div>
    </aside>
  )
}
