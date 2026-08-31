import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"

const REPO_ROOT = resolve(__dirname, "..", "..")
const CSS = readFileSync(resolve(REPO_ROOT, "app/globals.css"), "utf8")

function rg(...args: string[]): string[] {
  try {
    return execFileSync("rg", args, { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

/**
 * Three files each spelled `h-10` and each carried a comment calling it "the
 * shared column-header height" — while Inbox used `h-12` and Settings `h-14`.
 * A repeated literal with a shared name in the comments is a token that never
 * got written down (ADR-0148).
 *
 * There are genuinely two heights, not one: a column header holds icon buttons
 * (40px), and a header holding a full input control cannot go below 56px
 * without clipping a 36px input inside its own padding. Naming both is the
 * point; collapsing them into one number would have broken the settings search.
 */
describe("chrome bar heights", () => {
  it("defines both named heights", () => {
    expect(CSS).toMatch(/--chrome-h:\s*2\.5rem/)
    expect(CSS).toMatch(/--chrome-h-tall:\s*3\.5rem/)
  })

  const BARS: Array<[string, string]> = [
    ["components/chat/chat-header.tsx", "--chrome-h"],
    ["components/desktop/channel-list.tsx", "--chrome-h"],
    ["components/desktop/title-bar.tsx", "--chrome-h"],
    ["components/inbox/conversation-list.tsx", "--chrome-h"],
    ["components/inbox/inbox-sidebar.tsx", "--chrome-h"],
    ["components/settings/settings-sidebar.tsx", "--chrome-h-tall"],
    ["components/feature-shell/feature-page-header.tsx", "--chrome-h"],
    ["components/workflow/editor/toolbar.tsx", "--chrome-h-tall"],
  ]

  it.each(BARS)("%s reads the height from %s", (file, token) => {
    const src = readFileSync(resolve(REPO_ROOT, file), "utf8")
    expect(src).toContain(`var(${token})`)
  })

  /**
   * Guard the guard, then guard the rule: no bar in this set may go back to a
   * literal height.
   */
  it("leaves no bar on a hardcoded height", () => {
    const offenders = BARS.map(([file]) => file).filter((file) => {
      const src = readFileSync(resolve(REPO_ROOT, file), "utf8")
      return /className="[^"\n]*\bh-1[024]\b[^"\n]*border-[bt]\b/.test(src)
    })
    expect(offenders).toEqual([])
  })

  it("scans a set that actually exists", () => {
    expect(BARS.length).toBeGreaterThanOrEqual(8)
    for (const [file] of BARS) {
      expect(rg("--files", file).length).toBe(1)
    }
  })
})
