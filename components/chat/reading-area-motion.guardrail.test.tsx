/** @jest-environment jsdom */

/**
 * The reading area's layout-stability contract, as an executable rule (ADR-0138).
 *
 * Two things made the transcript jitter, and both are the kind of mistake that
 * is invisible in review and expensive in the shell:
 *
 *   1. **Motion that changes layout size.** Every row in the transcript is
 *      watched by a `ResizeObserver` (the virtualizer's `measureElement`, and
 *      the content observer behind `useStickToBottom`), so a height/width tween
 *      is one layout change per frame for the length of the animation.
 *   2. **Scroll correction after paint.** `useEffect` and `requestAnimationFrame`
 *      both run after the browser has painted, so a pin written from either one
 *      shows the reader the jump first and undoes it a frame later.
 *
 * This suite reads the reading-area sources and fails on either. It is a source
 * scan rather than a render assertion on purpose: `__mocks__/motion-react.js`
 * renders `AnimatePresence` children straight through and never runs a timeline,
 * so neither failure mode is reproducible in jsdom at all — the only place to
 * catch a regression before the desktop shell is the source.
 *
 * Adding a component to the reading area? Add its path to
 * {@link READING_AREA_FILES}. Genuinely need an exception? Take the file back
 * out and say why in a comment right here — the point is that it becomes a
 * decision someone made, not something that drifted back in.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..")

/**
 * Everything that renders inside the scrolling transcript, where a row's size
 * is measured and its position is chased.
 */
const READING_AREA_FILES = [
  "components/chat/message-list.tsx",
  "components/chat/message-renderer.tsx",
  "components/chat/message-shell.tsx",
  "components/chat/streaming-text-part.tsx",
  "components/chat/thinking-indicator.tsx",
  "components/chat/thinking-tips.tsx",
  "components/chat/message-parts/artifact-part.tsx",
  "components/chat/message-parts/canvas-inline-part.tsx",
  "components/chat/message-parts/tool-call-row.tsx",
  "components/chat/message-parts/tool-activity-group.tsx",
  "components/chat/message-parts/subagent-part.tsx",
  "components/chat/message-parts/subagent-tree.tsx",
]

/** Files that own the transcript's scroll position. */
const SCROLL_OWNER_FILES = ["components/chat/message-list.tsx", "hooks/chat/use-stick-to-bottom.ts"]

const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), "utf8")

/** Strip block and line comments so prose about the rule never trips the rule. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("reading-area motion may not touch layout size", () => {
  it.each(READING_AREA_FILES)("%s animates no height or width", (relative) => {
    const source = stripComments(read(relative))

    // `MotionCollapse` is the settings-panel disclosure: it tweens `height` to
    // and from `auto`. `ReadingCollapse` is its reading-area counterpart.
    expect(source).not.toContain("MotionCollapse")

    // A motion target naming a box dimension, e.g. `animate={{ height: "auto" }}`
    // or `exit={{ width: 0 }}`. Transforms and opacity are fine — they never
    // reach layout, so no observer can see them.
    const animatedBox =
      /(?:initial|animate|exit|whileHover|whileTap)=\{\{[^}]*\b(?:height|width|minHeight|maxHeight)\b/
    expect(source).not.toMatch(animatedBox)

    // The CSS equivalents: a Tailwind transition that includes a box dimension.
    expect(source).not.toMatch(/transition-\[[^\]]*\b(?:height|width)\b/)
    expect(source).not.toContain("transition-all")
  })
})

describe("the transcript's scroll position is corrected before paint", () => {
  it.each(SCROLL_OWNER_FILES)("%s writes scrollTop only from the layout phase", (relative) => {
    const source = stripComments(read(relative))
    if (!source.includes("scrollTop =")) return

    // `useEffect` and `requestAnimationFrame` both land after paint, so a pin
    // from either shows the jump and then undoes it. Layout effects and
    // ResizeObserver callbacks are the two pre-paint seams.
    expect(source).not.toMatch(/useEffect\([^)]*\)?[\s\S]{0,400}?scrollTop =/)
    expect(source).not.toMatch(/requestAnimationFrame\([\s\S]{0,400}?scrollTop =/)
  })

  it("keeps the list itself out of the scrollTop business entirely", () => {
    // One owner. `scrollTo` (the smooth, user-initiated jumps) is a different
    // concern and stays where it is.
    const source = stripComments(read("components/chat/message-list.tsx"))
    expect(source).not.toContain("scrollTop =")
    expect(source).toContain("useStickToBottom")
  })
})
