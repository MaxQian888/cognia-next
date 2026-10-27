/** @jest-environment jsdom */

import { measureWorkbenchHeaderMinimumWidth } from "./header-minimum-width"

function sized(element: HTMLElement, width: number, scrollWidth = width) {
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: width })
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: scrollWidth })
  return element
}

function headerFixture() {
  const header = sized(document.createElement("header"), 200)
  header.style.cssText = "display:flex;column-gap:4px;padding:0 8px"
  const tabs = sized(document.createElement("div"), 40, 300)
  const active = sized(document.createElement("div"), 88)
  active.setAttribute("data-workbench-active-tab", "true")
  tabs.append(active, sized(document.createElement("div"), 212))
  header.append(tabs)
  for (let index = 0; index < 4; index++) header.append(sized(document.createElement("button"), 32))
  document.body.append(header)
  return { header, active }
}

afterEach(() => document.body.replaceChildren())

describe("measureWorkbenchHeaderMinimumWidth", () => {
  it("reserves the complete active tab and actions, not the clipped tab strip", () => {
    const { header } = headerFixture()
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(248)
    sized(header, 400)
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(248)
  })

  it("remeasures changed tab text or font metrics without counting inactive tabs", () => {
    const { header, active } = headerFixture()
    sized(active, 132)
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(292)
  })

  it("does not turn flexible spacer allocation into a content minimum", () => {
    const { header } = headerFixture()
    const spacer = sized(document.createElement("div"), 200)
    spacer.setAttribute("data-workbench-spacer", "true")
    header.append(spacer)
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(252)
    sized(spacer, 400)
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(252)
  })

  it("excludes hidden actions and includes visible margins and header padding", () => {
    const { header } = headerFixture()
    const action = header.lastElementChild as HTMLElement
    action.style.display = "none"
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(212)
    action.style.cssText = "display:block;margin-left:2px;margin-right:2px"
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(252)
  })

  it("uses the intrinsic title width in rail mode instead of its flexible allocation", () => {
    const header = sized(document.createElement("header"), 500)
    const title = sized(document.createElement("div"), 400)
    title.setAttribute("data-workbench-title", "true")
    title.style.columnGap = "6px"
    title.append(
      sized(document.createElement("span"), 14),
      sized(document.createElement("span"), 28)
    )
    header.append(title, sized(document.createElement("button"), 32))
    document.body.append(header)
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(80)
  })

  it("ignores an unmeasured or hidden header", () => {
    const { header } = headerFixture()
    sized(header, 0)
    expect(measureWorkbenchHeaderMinimumWidth(header)).toBe(0)
  })
})
