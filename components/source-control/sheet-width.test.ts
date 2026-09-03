import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const DIR = resolve(__dirname)

/**
 * Every right-side sheet must be `w-full sm:max-w-*`, never a bare width.
 *
 * `components/ui/sheet.tsx` gives `side="right"` the base classes
 * `w-3/4 … sm:max-w-sm`, and `cn()` is tailwind-merge, where `w-*` and
 * `max-w-*` are different conflict groups. So a caller that sets only a width
 * does NOT remove `sm:max-w-sm`, and the sheet renders at 24rem above 640px no
 * matter what it asked for.
 *
 * Four sheets here were broken in both directions at once. Blame declared
 * `w-[40rem]` and compare-refs `w-[44rem]`, and both drew at 384px on a
 * desktop, the same width as the tag list. Below 640px the same classes
 * overflowed a 375px viewport instead of going full-bleed.
 *
 * `w-full` beats the base `w-3/4` and `sm:max-w-*` replaces `sm:max-w-sm`, so
 * the pair fixes the narrow overflow and restores the intended desktop width
 * in one move.
 */
describe("source-control sheet widths", () => {
  const files = readdirSync(DIR).filter(
    (name) => name.endsWith(".tsx") && !name.includes(".test.") && !name.includes(".stories.")
  )

  /** Every `<SheetContent …>` open tag, with its own attributes only. */
  const tags = files.flatMap((name) => {
    const source = readFileSync(resolve(DIR, name), "utf8")
    return [...source.matchAll(/<SheetContent\b[^>]*>/g)].map((match) => ({
      file: name,
      tag: match[0],
      className: /className="([^"]*)"/.exec(match[0])?.[1] ?? "",
    }))
  })

  // A guard on the guard. A sweep that matched nothing would pass every
  // assertion below while checking exactly zero sheets.
  it("found the sheets it is meant to police", () => {
    expect(tags.length).toBeGreaterThanOrEqual(7)
    expect(tags.every((entry) => entry.className !== "")).toBe(true)
  })

  it.each(tags.map((entry) => [`${entry.file}: ${entry.className}`, entry] as const))(
    "%s goes full-bleed below sm and caps above it",
    (_label, entry) => {
      expect(entry.className).toMatch(/\bw-full\b/)
      expect(entry.className).toMatch(/\bsm:max-w-/)
    }
  )

  it("leaves no sheet on a bare width that sm:max-w-sm would silently cap", () => {
    const offenders = tags
      .filter((entry) => /\bw-\[|\bw-9\d\b|\bsm:w-\[/.test(entry.className))
      .map((entry) => `${entry.file}: ${entry.className}`)
    expect(offenders).toEqual([])
  })
})
