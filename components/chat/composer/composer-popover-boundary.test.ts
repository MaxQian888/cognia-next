/**
 * @jest-environment jsdom
 */
import {
  COMPOSER_POPOVER_COLLISION_PADDING,
  COMPOSER_POPOVER_FIT_CLASS,
  COMPOSER_ROOT_ATTRIBUTE,
  resolveComposerPopoverBoundary,
} from "./composer-popover-boundary"

afterEach(() => {
  document.body.innerHTML = ""
})

function build(html: string) {
  document.body.innerHTML = html
  return (id: string) => document.getElementById(id) as HTMLElement
}

describe("resolveComposerPopoverBoundary", () => {
  it("returns the composer's nearest clipping ancestor (the docked chat column)", () => {
    const byId = build(`
      <div id="pane" style="overflow: hidden">
        <div id="column">
          <div id="root" ${COMPOSER_ROOT_ATTRIBUTE}="" data-placement="docked">
            <div id="clip" style="overflow-y: auto">
              <div id="anchor"></div>
            </div>
          </div>
        </div>
      </div>`)
    // The composer's own scroll band (inside the root) is skipped: the bound is
    // measured from the composer root outward.
    expect(resolveComposerPopoverBoundary(byId("anchor"))).toBe(byId("pane"))
  })

  it("returns the welcome page's scroll container for the hero composer", () => {
    const byId = build(`
      <div id="welcome" style="overflow-y: auto">
        <div><div id="root" ${COMPOSER_ROOT_ATTRIBUTE}="" data-placement="hero">
          <div id="anchor"></div>
        </div></div>
      </div>`)
    expect(resolveComposerPopoverBoundary(byId("anchor"))).toBe(byId("welcome"))
  })

  it("falls back to the viewport (null) without a clipping ancestor", () => {
    const byId = build(
      `<div><div id="root" ${COMPOSER_ROOT_ATTRIBUTE}=""><div id="anchor"></div></div></div>`
    )
    expect(resolveComposerPopoverBoundary(byId("anchor"))).toBeNull()
  })

  it("walks from the anchor itself when there is no composer root", () => {
    const byId = build(`<div id="clip" style="overflow: clip"><div id="anchor"></div></div>`)
    expect(resolveComposerPopoverBoundary(byId("anchor"))).toBe(byId("clip"))
  })

  it("returns null for a missing anchor", () => {
    expect(resolveComposerPopoverBoundary(null)).toBeNull()
  })

  it("exposes the padding and the fit classes the popovers share", () => {
    expect(COMPOSER_POPOVER_COLLISION_PADDING).toBeGreaterThan(0)
    expect(COMPOSER_POPOVER_FIT_CLASS).toContain(
      "max-h-[var(--radix-popover-content-available-height)]"
    )
    expect(COMPOSER_POPOVER_FIT_CLASS).toContain("flex-col")
  })
})
