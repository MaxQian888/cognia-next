import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"

const REPO_ROOT = resolve(__dirname, "..", "..")

function rg(...args: string[]): string[] {
  try {
    return execFileSync("rg", args, { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
  } catch (err) {
    // rg exits 1 when nothing matches — that is a valid empty result.
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

const CSS = readFileSync(resolve(REPO_ROOT, "app/globals.css"), "utf8")

/**
 * `rounded-full` is not a style-pack axis — a status dot, a spinner ring and an
 * avatar have to stay circular however square the rest of the UI gets. Padded
 * capsules (badges, chips, segmented controls) are chrome and do follow the
 * pack, via `rounded-pill` / `--pill-radius`. These tests pin that split so a
 * future edit cannot quietly square a spinner or leave a badge round.
 */
describe("pill vs circle", () => {
  const SOURCE_GLOBS = [
    "--glob",
    "!**/*.test.*",
    "--glob",
    "!**/*.stories.*",
    "components/",
    "app/",
    "plugins/",
  ]

  it("scans a source tree that actually has radius utilities", () => {
    const all = rg("-c", "--no-heading", "rounded-", ...SOURCE_GLOBS)
    expect(all.length).toBeGreaterThan(200)
  })

  it("leaves no padded capsule on rounded-full", () => {
    // A class string carrying both `rounded-full` and horizontal padding is a
    // capsule, never a circle.
    const offenders = rg(
      "-n",
      "--no-heading",
      String.raw`"[^"\n]*rounded-full[^"\n]*\bpx-[0-9.]+[^"\n]*"|"[^"\n]*\bpx-[0-9.]+[^"\n]*rounded-full[^"\n]*"`,
      ...SOURCE_GLOBS
    )
    expect(offenders).toEqual([])
  })

  it("keeps genuinely circular primitives on rounded-full", () => {
    for (const file of [
      "components/ui/avatar.tsx",
      "components/ui/radio-group.tsx",
      "components/ui/loading-states.tsx",
    ]) {
      const src = readFileSync(resolve(REPO_ROOT, file), "utf8")
      expect(src).toContain("rounded-full")
      expect(src).not.toContain("rounded-pill")
    }
  })

  it("routes the capsule primitives through the pack", () => {
    for (const file of [
      "components/ui/badge.tsx",
      "components/ui/switch.tsx",
      "components/ui/progress.tsx",
      "components/ui/slider.tsx",
    ]) {
      const src = readFileSync(resolve(REPO_ROOT, file), "utf8")
      expect(src).toContain("rounded-pill")
      expect(src).not.toContain("rounded-full")
    }
  })

  /**
   * `--pill-radius` defaults to 9999px, which renders identically to Tailwind's
   * `calc(infinity * 1px)` for any real element — that equivalence is what makes
   * the mass rename invisible under the Soft pack.
   */
  it("defaults --pill-radius to a fully-rounded value", () => {
    expect(CSS).toMatch(/--pill-radius:\s*9999px/)
    expect(CSS).toMatch(/--radius-pill:\s*var\(--pill-radius\)/)
  })

  it("rebases the untracked 2xl/3xl steps under a pack only", () => {
    expect(CSS).toMatch(/html\[data-style-pack="sharp"\] \.rounded-2xl/)
    expect(CSS).toMatch(/html\[data-style-pack="studio"\] \.rounded-3xl/)
    // Never unconditionally — that would move the default look.
    expect(CSS).not.toMatch(/^\.rounded-2xl\s*\{\s*border-radius: var\(--radius-stage\)/m)
  })
})
