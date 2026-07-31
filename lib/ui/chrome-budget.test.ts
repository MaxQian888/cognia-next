/**
 * @jest-environment jsdom
 */
import {
  CHROME_BUDGET,
  INTERACTIVE_SELECTOR,
  countControls,
  countInteractive,
} from "./chrome-budget"

function mount(html: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("countInteractive", () => {
  it("counts buttons, links, form fields, and ARIA widgets", () => {
    const host = mount(`
      <button>a</button>
      <a href="/x">b</a>
      <select></select>
      <textarea></textarea>
      <input type="text" />
      <span role="button">c</span>
      <div role="menuitem">d</div>
      <div role="checkbox"></div>
      <div role="switch"></div>
      <div role="tab"></div>
    `)
    expect(countInteractive(host)).toBe(10)
  })

  it("counts an element matching several clauses only once", () => {
    // A `<button role="button">` satisfies two selector clauses; querySelectorAll
    // returns a unique set, so the budget must not double-charge it.
    const host = mount(`<button role="button">a</button>`)
    expect(countInteractive(host)).toBe(1)
  })

  it("ignores anchors without an href and hidden inputs", () => {
    const host = mount(`<a>no href</a><input type="hidden" />`)
    expect(countInteractive(host)).toBe(0)
  })

  it("ignores elements hidden from the accessibility tree", () => {
    const host = mount(`
      <button aria-hidden="true">decorative</button>
      <button hidden>collapsed</button>
      <button>real</button>
    `)
    expect(countInteractive(host)).toBe(1)
  })

  it("ignores controls nested under an aria-hidden ancestor", () => {
    const host = mount(`<div aria-hidden="true"><button>inside</button></div>`)
    expect(countInteractive(host)).toBe(0)
  })

  it("treats an aria-hidden root as hiding everything inside it", () => {
    const host = mount(`<button>a</button>`)
    host.setAttribute("aria-hidden", "true")
    expect(countInteractive(host)).toBe(0)
  })

  it("stops walking at the root and ignores an aria-hidden ancestor above it", () => {
    // A band's container is the unit under test; whatever wraps it in the app
    // (or in RTL) must not silently zero out the count.
    const outer = mount(`<div><section><button>a</button></section></div>`)
    outer.setAttribute("aria-hidden", "true")
    const root = outer.querySelector("section")
    expect(countInteractive(root)).toBe(1)
  })

  it("returns 0 for a missing root", () => {
    expect(countInteractive(null)).toBe(0)
    expect(countInteractive(undefined)).toBe(0)
  })
})

describe("countControls", () => {
  it("counts real interactive elements exactly like countInteractive", () => {
    const host = mount(`<button>a</button><a href="/x">b</a>`)
    expect(countControls(host)).toBe(2)
    expect(countControls(host)).toBe(countInteractive(host))
  })

  it("counts a mocked child component rendered as a leaf test stub", () => {
    // The shape every band test uses: jest.mock(...) → <div data-testid="x" />.
    // countInteractive misses these entirely, which is why the budget uses this.
    const host = mount(`
      <div data-testid="effort-selector"></div>
      <div data-testid="permission-mode-indicator"></div>
    `)
    expect(countInteractive(host)).toBe(0)
    expect(countControls(host)).toBe(2)
  })

  it("charges a real component once, through its button rather than its wrapper", () => {
    const host = mount(`<div data-testid="model-picker"><button>Sonnet</button></div>`)
    expect(countControls(host)).toBe(1)
  })

  it("does not charge a container test id that holds other controls", () => {
    const host = mount(`
      <footer data-testid="status-bar">
        <button>a</button>
        <div data-testid="status-sync"></div>
      </footer>
    `)
    // The button + the leaf stub — never the footer wrapping them.
    expect(countControls(host)).toBe(2)
  })

  it("does not charge a test id whose only descendants are other test ids", () => {
    const host = mount(`
      <div data-testid="group"><div data-testid="leaf"></div></div>
    `)
    expect(countControls(host)).toBe(1)
  })

  it("skips stubs hidden from the accessibility tree", () => {
    const host = mount(`
      <div data-testid="decorative" aria-hidden="true"></div>
      <div data-testid="real"></div>
    `)
    expect(countControls(host)).toBe(1)
  })

  it("counts an interactive element carrying its own test id only once", () => {
    const host = mount(`<button data-testid="composer-toolbar-more">…</button>`)
    expect(countControls(host)).toBe(1)
  })

  it("returns 0 for a missing root", () => {
    expect(countControls(null)).toBe(0)
    expect(countControls(undefined)).toBe(0)
  })
})

describe("CHROME_BUDGET", () => {
  it("covers every chrome band asserted by the shell tests", () => {
    expect(Object.keys(CHROME_BUDGET).sort()).toEqual([
      "chatHeader",
      "composerToolbar",
      "guildRail",
      "inboxConversationHeader",
      "statusBar",
      "titleBar",
    ])
  })

  it("holds positive ceilings — a 0 would mean the band was never measured", () => {
    const unmeasured = Object.entries(CHROME_BUDGET)
      .filter(([, ceiling]) => ceiling <= 0)
      .map(([band]) => band)
    expect(unmeasured).toEqual([])
  })

  it("keeps the selector list free of duplicates", () => {
    const clauses = INTERACTIVE_SELECTOR.split(", ")
    expect(new Set(clauses).size).toBe(clauses.length)
  })
})
