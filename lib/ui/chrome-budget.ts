/**
 * Chrome control budget — the ratchet that keeps the default shell calm.
 *
 * Before the de-crowding pass the five bands below mounted 65 controls between
 * them (rail 17, status bar 16, title bar 13, composer toolbar 11, chat header
 * 8) — plus a tab strip that rendered even for a single session — all of it
 * before the user typed a character. The shell now keeps only the high-value
 * permanent controls, and the tab strip appears only once there is something
 * to switch between.
 *
 * Nothing stops the next feature from putting its button straight back on the
 * default surface, so each band asserts against {@link CHROME_BUDGET} from its
 * own test file. Adding a control to a saturated band fails that band's test:
 * the author must either take one out or make the case for raising the number.
 *
 * ## What is counted
 *
 * Interactive elements **mounted** in the band's default state — not pixels.
 * jsdom applies no Tailwind, so a `hidden md:inline-flex` element still counts;
 * likewise a Radix menu's items only count once the menu is open, which it is
 * not in these renders. That makes the number a stable proxy rather than a
 * literal "what a 1440px viewport shows", and it ratchets in the right
 * direction either way: removing a control always lowers it.
 *
 * Consequence worth knowing before you chase a number: moving a control from
 * the surface into a closed dropdown *does* reduce the count, which is exactly
 * the behaviour we want to reward. Moving it into a permanently-mounted
 * container does not.
 */

/**
 * Elements a user can act on. Deliberately broader than `button` — the shell
 * uses `role="button"` spans, Radix checkbox/switch items, and bare anchors.
 * `querySelectorAll` de-duplicates, so an element matching two clauses (a
 * `<button role="button">`) is still counted once.
 */
export const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "select",
  "textarea",
  'input:not([type="hidden"])',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="link"]',
].join(", ")

/**
 * Count the interactive elements under `root`, skipping anything the
 * accessibility tree already hides (`aria-hidden` / `hidden` on the element or
 * any ancestor). A decorative icon-only span marked `aria-hidden` is not a
 * control and must not inflate a band's budget.
 */
export function countInteractive(root: ParentNode | null | undefined): number {
  if (!root) return 0
  const matches = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR))
  return matches.filter((el) => !isHiddenFromTree(el, root)).length
}

/**
 * The budget metric: every control the band mounts, whether it rendered as a
 * real interactive element or as a test stub.
 *
 * {@link countInteractive} alone is not enough here. Band tests mock their
 * children heavily — `bottom-toolbar.test.tsx` stubs the model picker, effort
 * selector, permission chip, web-search toggle and every agent selector as
 * `<div data-testid="…" />`. Counting only interactive elements saw 4 of the
 * toolbar's ~12 controls, which would let someone add a control and keep the
 * ratchet green, defeating the point.
 *
 * So a control is either an interactive element, or a **leaf** `data-testid`
 * node — one with no interactive descendant, which is exactly the shape a
 * mocked child component takes. A real component wraps its `data-testid`
 * around a `<button>`, so it has an interactive descendant and is counted once
 * through that button rather than twice. Container test ids (`status-bar`,
 * `title-bar`) hold controls, so they are never leaves.
 */
export function countControls(root: ParentNode | null | undefined): number {
  if (!root) return 0
  const interactive = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter(
    (el) => !isHiddenFromTree(el, root)
  )
  const seen = new Set<HTMLElement>(interactive)
  const stubs = Array.from(root.querySelectorAll<HTMLElement>("[data-testid]")).filter(
    (el) =>
      !seen.has(el) &&
      !isHiddenFromTree(el, root) &&
      el.querySelector(INTERACTIVE_SELECTOR) === null &&
      el.querySelector("[data-testid]") === null
  )
  return interactive.length + stubs.length
}

/** Walk up to `root` looking for an `aria-hidden="true"` / `hidden` ancestor. */
function isHiddenFromTree(el: HTMLElement, root: ParentNode): boolean {
  let node: HTMLElement | null = el
  while (node) {
    if (node.getAttribute("aria-hidden") === "true") return true
    if (node.hasAttribute("hidden")) return true
    if ((node as unknown as ParentNode) === root) return false
    node = node.parentElement
  }
  return false
}

/**
 * Per-band ceilings for the **default** state — no session selected beyond the
 * first, no team, no plugin contributions, every optional segment at its
 * shipped default. Each entry is asserted by that band's own test file.
 *
 * These are ceilings, not targets: landing under one is free, going over is a
 * deliberate decision that belongs in review. Raise a number only alongside the
 * reasoning for why that band earned another permanent control.
 */
export const CHROME_BUDGET = {
  /**
   * `components/desktop/title-bar.tsx` — macOS (no in-window menubar).
   * Includes the VS Code-style Primary Side Bar / Panel / Secondary Side Bar
   * quick toggles; the lower-value Activity Bar and Status Bar toggles stay in
   * the adjacent Customize Layout dropdown.
   */
  titleBar: 10,
  /**
   * `components/desktop/status-bar.tsx`. The live bar sits one below this: its
   * test stubs `AttentionPanel` as a plain button, while the real one renders
   * nothing until something is actually pending.
   */
  statusBar: 9,
  /** `components/shell/guild-rail.tsx` — no teams, no plugin view containers. */
  guildRail: 9,
  /** `components/chat/chat-header.tsx` */
  chatHeader: 2,
  /**
   * `components/chat/composer/bottom-toolbar.tsx` — wide (non-compact) branch.
   * Six intentionally includes the Agent runtime selector: model + runtime are
   * the two execution-shape choices users need before sending, while detailed
   * Agent mode and external-agent configuration remain in the overflow.
   */
  composerToolbar: 6,
  /**
   * `components/inbox/conversation-header.tsx`, desktop branch. Five of these
   * are the strip proper — platform badge, mode switcher, `⋯` overflow,
   * artifact-dock toggle, overrides gear — plus the back button and sidebar
   * trigger, which are `md:hidden` but still in the DOM (`countControls` reads
   * the tree, not the cascade).
   *
   * This was ~20 before the overflow popover landed. The row laid every
   * control out flat, and because `buttonVariants` / `badgeVariants` bake
   * `shrink-0` into their base, none of them compressed — the strip ran past
   * the pane, which `ResizablePanel` clips, so the trailing gear was
   * unreachable. Adding a control back here re-opens that failure mode.
   */
  inboxConversationHeader: 7,
} as const

export type ChromeBudgetBand = keyof typeof CHROME_BUDGET
