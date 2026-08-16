/**
 * The docs site is prerendered to static HTML by whichever machine runs
 * `pnpm docs:build`, so anything that reads an ambient time zone bakes that
 * machine's environment into `docs/out/`. Pinning one zone keeps the markup
 * byte-identical across build hosts — the same reason the product app pins it
 * on its own provider (`components/providers/locale-gate.tsx`).
 *
 * This doubles as next-intl's global default. Without it `useTranslations()`
 * reports `ENVIRONMENT_FALLBACK` the first time it runs on the server in each
 * prerender worker — which is why the warning appeared ~once per worker rather
 * than once per page, and why every page emitted it via `<PageActions />`, not
 * only the pages that render a date.
 */
export const DOCS_TIME_ZONE = "UTC"

/** Locale tag used to format build-time dates for a docs language segment. */
function dateLocale(locale: "en" | "zh" | null): string {
  return locale === "zh" ? "zh-CN" : "en-US"
}

/**
 * Formats a build-time ISO timestamp for display.
 *
 * `new Date(iso).toLocaleDateString()` — what this replaced in the page footer
 * — takes *both* the locale and the time zone from the build machine, so one
 * commit rendered "2026/7/22" on a zh_CN host and "7/22/2026" on a US one, and
 * landed on different calendar days either side of midnight. Both inputs are
 * explicit here.
 *
 * Returns null for a value that isn't a parseable date: callers hide the line
 * rather than print "Invalid Date", and `Intl.DateTimeFormat#format` would
 * otherwise throw and fail the whole prerender.
 */
export function formatDocsDate(iso: string, locale: "en" | "zh" | null): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null

  return new Intl.DateTimeFormat(dateLocale(locale), {
    timeZone: DOCS_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date)
}
