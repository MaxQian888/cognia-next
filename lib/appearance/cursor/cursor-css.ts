// The injected stylesheet that swaps the pointer art in.
//
// Strategy: `cursor` is an inherited property, so the *default* role is set
// once on `<html>`/`<body>` and reaches everything that doesn't declare its
// own. Only the elements that DO declare one need explicit rules — links,
// form controls, and the Tailwind `cursor-*` utilities the app uses. A blanket
// `* { cursor: … }` would have been shorter and is what most "custom cursor"
// snippets do; it also stomps the resize/col-resize cursors inside Monaco, the
// terminal, and every resizable panel, which is why it isn't used here.
//
// Rule order is load-bearing: roles are emitted in the order below so that
// equal-specificity selectors resolve the way a user expects — `grabbing`
// beats `grab`, and `notAllowed` beats everything, because a disabled control
// that still says "clickable" is a real bug.

import type { CursorRole } from "@/types/appearance"

export const CURSOR_STYLE_ELEMENT_ID = "cognia-cursor"

/** Attribute stamped on `<html>` carrying the active pack id. */
export const CURSOR_ROOT_ATTR = "data-cursor-pack"

/** Scope guard — the sheet is inert if the attribute is absent. */
const ROOT = `html[${CURSOR_ROOT_ATTR}]`

/**
 * Emission order. Later roles win ties, so this list reads as a precedence
 * ladder from "most general" to "most overriding".
 */
export const CURSOR_ROLE_ORDER: readonly CursorRole[] = [
  "default",
  "text",
  "crosshair",
  "progress",
  "pointer",
  "grab",
  "grabbing",
  "notAllowed",
]

/**
 * Selectors per role, relative to the scope root.
 *
 * `""` is the root itself. Element selectors cover the platform defaults (a
 * link's pointer, an input's I-beam); the `.cursor-*` entries cover the
 * Tailwind utilities the app writes explicitly, which out-specify inheritance
 * and would otherwise punch native cursors through the theme.
 */
export const CURSOR_ROLE_SELECTORS: Record<CursorRole, readonly string[]> = {
  default: ["", "body", ".cursor-default"],
  pointer: [
    "a[href]",
    "button",
    "summary",
    "select",
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="reset"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="switch"]',
    ".cursor-pointer",
  ],
  text: [
    "input:not([type])",
    'input[type="text"]',
    'input[type="search"]',
    'input[type="email"]',
    'input[type="password"]',
    'input[type="url"]',
    'input[type="tel"]',
    'input[type="number"]',
    "textarea",
    '[contenteditable="true"]',
    ".cursor-text",
  ],
  grab: [".cursor-grab"],
  grabbing: [".cursor-grabbing", ".cursor-grab:active"],
  notAllowed: [
    ":disabled",
    '[aria-disabled="true"]',
    '[data-disabled="true"]',
    ".cursor-not-allowed",
  ],
  progress: ['[aria-busy="true"]', ".cursor-progress", ".cursor-wait"],
  crosshair: [".cursor-crosshair"],
}

/** One rendered role: the CSS `cursor` value to emit for it. */
export interface CursorRoleCss {
  role: CursorRole
  /** Full property value, e.g. `url("data:…") 3 2, pointer`. */
  value: string
}

function scopeSelector(selector: string): string {
  return selector ? `${ROOT} ${selector}` : ROOT
}

/**
 * Build the stylesheet text for a set of rendered roles.
 *
 * Roles absent from `roles` emit nothing at all — that is how a pack declaring
 * a subset hands the remaining cursors back to the operating system. An empty
 * input yields an empty string rather than an empty-but-present sheet.
 */
export function buildCursorCss(roles: readonly CursorRoleCss[]): string {
  const byRole = new Map(roles.map((r) => [r.role, r.value]))
  const blocks: string[] = []
  for (const role of CURSOR_ROLE_ORDER) {
    const value = byRole.get(role)
    if (!value) continue
    const selectors = CURSOR_ROLE_SELECTORS[role].map(scopeSelector).join(",\n")
    blocks.push(`${selectors} {\n  cursor: ${value};\n}`)
  }
  return blocks.join("\n\n")
}
