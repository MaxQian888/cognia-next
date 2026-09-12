/**
 * @jest-environment jsdom
 *
 * `lib/` suites default to the `node` project, and every assertion here needs a
 * real Document.
 */

import {
  PICKER_NODE_ATTRIBUTE,
  buildElementSelection,
  cssSelector,
  domPath,
  installElementPicker,
  outerHtmlLimit,
  shallowProps,
} from "./element-pick"

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

afterEach(() => {
  document.body.innerHTML = ""
  document.documentElement.style.cursor = ""
})

describe("cssSelector", () => {
  it("stops at the nearest id and omits :nth-of-type(1)", () => {
    mount(`<div id="card"><section><button>Go</button></section></div>`)
    const button = document.querySelector("button")!
    expect(cssSelector(button)).toBe("#card > section > button")
  })

  it("disambiguates same-tag siblings by :nth-of-type", () => {
    mount(`<ul><li>a</li><li>b</li><li>c</li></ul>`)
    const third = document.querySelectorAll("li")[2]
    // `body` is part of the path: the walk stops at `html`, not at `body`.
    expect(cssSelector(third)).toBe("body > ul > li:nth-of-type(3)")
  })

  it("counts only same-tag siblings, not every preceding element", () => {
    mount(`<div><span>x</span><span>y</span><b>z</b><span>w</span></div>`)
    const b = document.querySelector("b")!
    // `b` is the third child but the FIRST <b>, so it carries no index.
    expect(cssSelector(b)).toBe("body > div > b")
  })

  it("escapes ids that are not bare identifiers", () => {
    mount(`<div id="a.b:c"><i>x</i></div>`)
    const i = document.querySelector("i")!
    expect(cssSelector(i).startsWith("#")).toBe(true)
    expect(cssSelector(i)).not.toBe("#a.b:c > i")
  })

  it("returns an empty string for a non-element", () => {
    expect(cssSelector(null)).toBe("")
  })
})

describe("domPath", () => {
  it("names the first class and stops before body", () => {
    mount(`<div class="card wide"><button id="submit">Go</button></div>`)
    const button = document.querySelector("button")!
    expect(domPath(button)).toBe("div.card > button#submit")
  })

  it("prefers an id over a class on the same node", () => {
    mount(`<div id="root" class="card"><i>x</i></div>`)
    expect(domPath(document.querySelector("i")!)).toBe("div#root > i")
  })

  it("caps the walk at six levels", () => {
    mount(
      `<div><div><div><div><div><div><div><i>deep</i></div></div></div></div></div></div></div>`
    )
    expect(domPath(document.querySelector("i")!).split(" > ")).toHaveLength(6)
  })
})

describe("outerHtmlLimit", () => {
  it("shrinks as more elements are picked at once", () => {
    expect(outerHtmlLimit(1)).toBe(4000)
    expect(outerHtmlLimit(3)).toBe(2000)
    expect(outerHtmlLimit(4)).toBe(800)
  })
})

describe("buildElementSelection", () => {
  it("captures the DOM core", () => {
    mount(`<div id="card"><button class="primary big" aria-label="Send it">Go</button></div>`)
    const selection = buildElementSelection(document.querySelector("button")!)
    expect(selection.tagName).toBe("button")
    expect(selection.selector).toBe("#card > button")
    expect(selection.classes).toBe("primary big")
    expect(selection.text).toBe("Go")
    expect(selection.accessibility).toEqual({ role: "button", name: "Send it" })
  })

  it("collapses whitespace in text and nearby text", () => {
    mount(`<div>  lots\n\n  of   space  <b>  bold\ttext </b></div>`)
    const selection = buildElementSelection(document.querySelector("b")!)
    expect(selection.text).toBe("bold text")
    expect(selection.nearbyText).toBe("lots of space bold text")
  })

  it("reports a null id rather than an empty string", () => {
    mount(`<div><i>x</i></div>`)
    expect(buildElementSelection(document.querySelector("i")!).id).toBeNull()
  })

  it("derives the implicit role of an input from its type", () => {
    mount(`<form><input type="checkbox" /></form>`)
    expect(buildElementSelection(document.querySelector("input")!).accessibility?.role).toBe(
      "checkbox"
    )
  })

  it("falls back to the placeholder for an input's accessible name", () => {
    mount(`<form><input placeholder="Your email" /></form>`)
    expect(buildElementSelection(document.querySelector("input")!).accessibility?.name).toBe(
      "Your email"
    )
  })

  it("truncates outerHTML against the multi-selection budget and says so", () => {
    mount(`<div><p>${"x".repeat(5000)}</p></div>`)
    const selection = buildElementSelection(document.querySelector("p")!, { selectionCount: 5 })
    expect(selection.outerHTML.length).toBeLessThanOrEqual(801)
    expect(selection.detailReduced).toEqual({
      selectionCount: 5,
      outerHTMLLimit: 800,
      reason: "multi-selection-budget",
    })
  })

  it("omits detailReduced for a single pick, so its absence means nothing was dropped", () => {
    mount(`<div><p>short</p></div>`)
    expect(buildElementSelection(document.querySelector("p")!).detailReduced).toBeUndefined()
  })

  it("stamps the origin label that the prompt heading will use", () => {
    mount(`<div><p>x</p></div>`)
    const selection = buildElementSelection(document.querySelector("p")!, {
      originLabel: "artifact preview",
    })
    expect(selection.originLabel).toBe("artifact preview")
  })

  it("reads the viewport from the element's OWN document view, not the ambient window", () => {
    // The same-origin iframe case: a picker installed by the parent describes
    // the frame's viewport, never the app's.
    const frame = document.createElement("iframe")
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument!
    frameDoc.body.innerHTML = `<button>inside</button>`
    Object.defineProperty(frame.contentWindow!, "innerWidth", { value: 321, configurable: true })
    Object.defineProperty(frame.contentWindow!, "innerHeight", { value: 123, configurable: true })

    const selection = buildElementSelection(frameDoc.querySelector("button")!)
    expect(selection.viewport).toEqual({ width: 321, height: 123 })
    expect(selection.viewport).not.toEqual({ width: window.innerWidth, height: window.innerHeight })
  })

  it("survives an element whose React fiber is malformed", () => {
    mount(`<div><button>Go</button></div>`)
    const button = document.querySelector("button")!
    Object.defineProperty(button, "__reactFiber$broken", {
      get() {
        throw new Error("torn fiber")
      },
    })
    const selection = buildElementSelection(button)
    expect(selection.tagName).toBe("button")
    expect(selection.componentName).toBeUndefined()
  })

  it("names the owning React component when a fiber is present", () => {
    mount(`<div><button>Go</button></div>`)
    const button = document.querySelector("button")!
    const owner = { type: { displayName: "SubmitButton" }, memoizedProps: { tone: "primary" } }
    Object.assign(button, {
      ["__reactFiber$test"]: { type: "button", return: { ...owner, return: null } },
    })
    const selection = buildElementSelection(button)
    expect(selection.componentName).toBe("SubmitButton")
    expect(selection.framework).toBe("react")
    expect(selection.props).toEqual({ tone: "primary" })
  })

  it("reads a react-dev-inspector source hint off an ancestor", () => {
    mount(
      `<div data-inspector-relative-path="app/page.tsx" data-inspector-line="42" data-inspector-column="7"><span><i>x</i></span></div>`
    )
    expect(buildElementSelection(document.querySelector("i")!).sourceHint).toEqual({
      path: "app/page.tsx",
      line: 42,
      column: 7,
    })
  })
})

describe("shallowProps", () => {
  it("keeps primitives, drops handlers and children, flattens containers", () => {
    expect(
      shallowProps({
        title: "Hi",
        count: 3,
        open: false,
        empty: null,
        onClick: () => {},
        children: "ignored",
        items: [1, 2],
        config: { a: 1 },
      })
    ).toEqual({
      title: "Hi",
      count: "3",
      open: "false",
      empty: "null",
      items: "[Array]",
      config: "[Object]",
    })
  })

  it("skips React elements", () => {
    expect(shallowProps({ icon: { $$typeof: Symbol.for("react.element") }, label: "x" })).toEqual({
      label: "x",
    })
  })

  it("returns null when nothing survives, so it is distinguishable from {}", () => {
    expect(shallowProps({ onClick: () => {}, children: "x" })).toBeNull()
    expect(shallowProps(null)).toBeNull()
  })

  it("caps the number of keys", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(shallowProps(many) ?? {}).length).toBeLessThanOrEqual(8)
  })
})

describe("installElementPicker", () => {
  it("picks the hovered element and swallows the artifact's own click", () => {
    mount(`<div id="card"><button>Go</button></div>`)
    const button = document.querySelector("button")!
    const artifactClick = jest.fn()
    button.addEventListener("click", artifactClick)

    const onPick = jest.fn()
    const dispose = installElementPicker(document, { onPick, originLabel: "artifact preview" })
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].selector).toBe("#card > button")
    expect(onPick.mock.calls[0][0].originLabel).toBe("artifact preview")
    // The whole point: selecting a button must not also press it.
    expect(artifactClick).not.toHaveBeenCalled()
    dispose()
  })

  it("reports the modifier keys, which decide queue-vs-send", () => {
    mount(`<div><button>Go</button></div>`)
    const onPick = jest.fn()
    const dispose = installElementPicker(document, { onPick })
    document
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }))
    expect(onPick.mock.calls[0][1]).toEqual({ metaKey: true, ctrlKey: false })
    dispose()
  })

  it("never offers its own chrome as a pick target", () => {
    mount(`<div><button>Go</button></div>`)
    const onPick = jest.fn()
    const dispose = installElementPicker(document, { onPick })

    const highlight = document.querySelector(`[${PICKER_NODE_ATTRIBUTE}="highlight"]`)
    expect(highlight).not.toBeNull()
    highlight!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(onPick).not.toHaveBeenCalled()
    dispose()
  })

  it("cancels on Escape", () => {
    mount(`<div><button>Go</button></div>`)
    const onCancel = jest.fn()
    const dispose = installElementPicker(document, { onPick: jest.fn(), onCancel })
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("tracks the hovered element with the highlight box", () => {
    mount(`<div><button>Go</button></div>`)
    const dispose = installElementPicker(document, { onPick: jest.fn() })
    const highlight = document.querySelector<HTMLElement>(`[${PICKER_NODE_ATTRIBUTE}="highlight"]`)!
    expect(highlight.style.opacity).toBe("0")

    document
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("pointermove", { bubbles: true }))
    expect(highlight.style.opacity).toBe("1")
    const label = document.querySelector<HTMLElement>(`[${PICKER_NODE_ATTRIBUTE}="label"]`)!
    expect(label.textContent).toBe("div > button")
    dispose()
  })

  it("restores the document completely on dispose — a leaked picker bricks the artifact", () => {
    mount(`<div><button>Go</button></div>`)
    const artifactClick = jest.fn()
    document.querySelector("button")!.addEventListener("click", artifactClick)

    const dispose = installElementPicker(document, { onPick: jest.fn() })
    expect(document.documentElement.style.cursor).toBe("crosshair")
    dispose()

    expect(document.querySelectorAll(`[${PICKER_NODE_ATTRIBUTE}]`)).toHaveLength(0)
    expect(document.documentElement.style.cursor).toBe("")
    document
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(artifactClick).toHaveBeenCalledTimes(1)
  })

  it("installs on a foreign document, which is the same-origin iframe case", () => {
    const frame = document.createElement("iframe")
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument!
    frameDoc.body.innerHTML = `<a href="#x">link</a>`

    const onPick = jest.fn()
    const dispose = installElementPicker(frameDoc, { onPick })
    frameDoc
      .querySelector("a")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].tagName).toBe("a")
    // The parent document must be untouched by a picker armed on the frame.
    expect(document.querySelectorAll(`[${PICKER_NODE_ATTRIBUTE}]`)).toHaveLength(0)
    dispose()
  })

  it("ignores everything outside its root — the renderer-transport case", () => {
    // A chart artifact draws in the APP's tree, so an unscoped picker would
    // offer the dock, the rail and the conversation as pick targets.
    mount(
      `<div id="app"><aside><button id="rail">rail</button></aside><div id="preview"><button id="bar">bar</button></div></div>`
    )
    const root = document.getElementById("preview")!
    const railClick = jest.fn()
    document.getElementById("rail")!.addEventListener("click", railClick)

    const onPick = jest.fn()
    const dispose = installElementPicker(document, { onPick, root })

    document
      .getElementById("rail")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(onPick).not.toHaveBeenCalled()
    // And the surrounding app stays usable while select mode is armed.
    expect(railClick).toHaveBeenCalledTimes(1)

    document
      .getElementById("bar")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].id).toBe("bar")
    dispose()
  })

  it("lets the root itself be picked", () => {
    mount(`<div id="preview"><span>x</span></div>`)
    const root = document.getElementById("preview")!
    const onPick = jest.fn()
    const dispose = installElementPicker(document, { onPick, root })
    root.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(onPick.mock.calls[0][0].id).toBe("preview")
    dispose()
  })

  it("drops the highlight when the pointer leaves the root", () => {
    mount(`<div id="outside">out</div><div id="preview"><b>in</b></div>`)
    const root = document.getElementById("preview")!
    const dispose = installElementPicker(document, { onPick: jest.fn(), root })
    const highlight = document.querySelector<HTMLElement>(`[${PICKER_NODE_ATTRIBUTE}="highlight"]`)!

    document.querySelector("b")!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }))
    expect(highlight.style.opacity).toBe("1")
    document
      .getElementById("outside")!
      .dispatchEvent(new MouseEvent("pointermove", { bubbles: true }))
    expect(highlight.style.opacity).toBe("0")
    dispose()
  })

  it("paints the crosshair on its root, not over the whole app", () => {
    mount(`<div id="preview"><b>in</b></div>`)
    const root = document.getElementById("preview")!
    const dispose = installElementPicker(document, { onPick: jest.fn(), root })
    expect(root.style.cursor).toBe("crosshair")
    expect(document.documentElement.style.cursor).toBe("")
    dispose()
    expect(root.style.cursor).toBe("")
  })

  it("returns a no-op disposer for a document with no body", () => {
    const bare = document.implementation.createDocument(null, null, null)
    expect(() =>
      installElementPicker(bare as unknown as Document, { onPick: jest.fn() })()
    ).not.toThrow()
  })
})
