import Link from "next/link"

type Props = {
  href: string
  title: string
  description?: string
  /** External URL opens in new tab. */
  external?: boolean
  /** Small label above the title — e.g. a section name. */
  eyebrow?: string
}

/**
 * Rich link card with hover affordance. Use for cross-page references where a
 * plain `[link](url)` would be too easy to miss.
 */
export function LinkCard({ href, title, description, external, eyebrow }: Props) {
  const isExternal = external ?? /^https?:\/\//.test(href)
  const Cmp = isExternal ? "a" : Link
  const props = isExternal ? { href, target: "_blank", rel: "noreferrer" } : { href }

  return (
    <Cmp
      {...(props as { href: string })}
      className="not-prose group my-4 flex items-center gap-4 rounded-lg border border-fd-border bg-fd-card px-4 py-3 no-underline transition-all hover:-translate-y-0.5 hover:border-fd-accent hover:shadow-md"
    >
      <div className="flex-1">
        {eyebrow ? (
          <div className="text-xs uppercase tracking-wider text-fd-muted-foreground">{eyebrow}</div>
        ) : null}
        <div className="font-semibold text-fd-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 text-sm text-fd-muted-foreground">{description}</div>
        ) : null}
      </div>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5 shrink-0 text-fd-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-fd-foreground"
        aria-hidden="true"
      >
        {isExternal ? (
          <>
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </>
        ) : (
          <>
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </>
        )}
      </svg>
    </Cmp>
  )
}
