import type { PageHeader as PageHeaderCopy } from "@web/content/types"

/**
 * The opening block of every sub-page. Carries the page's only `h1`, so a
 * reader arriving from search lands on a heading that names the page rather
 * than on the first section's heading.
 */
export function PageHeader({ copy }: { copy: PageHeaderCopy }) {
  return (
    <div className="border-b border-hairline bg-paper">
      <div className="mx-auto max-w-shell px-5 pb-16 pt-20 md:pt-28 lg:px-8">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.eyebrow}</p>
        <h1 className="mt-6 max-w-3xl text-balance text-4xl font-medium leading-[1.1] tracking-tight text-ink md:text-5xl lg:text-6xl">
          {copy.title}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{copy.subtitle}</p>
      </div>
    </div>
  )
}
