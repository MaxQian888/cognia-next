/**
 * @jest-environment jsdom
 */

import {
  EXPRESSION_FIELD_ATTR,
  FIELD_FOCUS_MAX_FRAMES,
  findFieldContainer,
  findFieldControl,
  focusFieldControl,
  focusFieldWhenReady,
  isInteractable,
  listInvalidFieldContainers,
  type FieldFocusOutcome,
} from "./field-focus"

function html(markup: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = markup
  document.body.appendChild(root)
  return root
}

/** Deterministic frame scheduler: `flush()` runs one queued frame. */
function manualFrames() {
  let next = 1
  const queue = new Map<number, () => void>()
  return {
    requestFrame: (cb: () => void) => {
      const id = next++
      queue.set(id, cb)
      return id
    },
    cancelFrame: (id: number) => {
      queue.delete(id)
    },
    flush: () => {
      const [id, cb] = queue.entries().next().value ?? []
      if (id === undefined || !cb) return false
      queue.delete(id)
      cb()
      return true
    },
    get pending() {
      return queue.size
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("isInteractable", () => {
  it("rejects anything under an inert or aria-hidden ancestor (a hidden workbench panel)", () => {
    const root = html(`
      <div inert><input id="inert" /></div>
      <div aria-hidden="true"><input id="hidden" /></div>
      <div><input id="live" /></div>
    `)
    expect(isInteractable(root.querySelector("#inert")!)).toBe(false)
    expect(isInteractable(root.querySelector("#hidden")!)).toBe(false)
    expect(isInteractable(root.querySelector("#live")!)).toBe(true)
  })

  it("honours checkVisibility where the engine provides it", () => {
    const root = html(`<input id="a" />`)
    const el = root.querySelector<HTMLElement>("#a")!
    Object.defineProperty(el, "checkVisibility", { value: () => false, configurable: true })
    expect(isInteractable(el)).toBe(false)
  })
})

describe("findFieldContainer", () => {
  it("matches the row by its param name", () => {
    const root = html(`
      <div data-field="systemPrompt"></div>
      <div data-field="prompt" id="prompt"></div>
    `)
    expect(findFieldContainer(root, "prompt")?.id).toBe("prompt")
  })

  it("never reads a param name as CSS", () => {
    const root = html(`<div data-field='a"]' id="odd"></div>`)
    expect(findFieldContainer(root, 'a"]')?.id).toBe("odd")
  })

  it("falls back to the first invalid row for a null or unrendered field", () => {
    const root = html(`
      <div data-field="a"></div>
      <div data-field="b" data-invalid="true" id="b"></div>
      <div data-field="c" data-invalid="true"></div>
    `)
    expect(findFieldContainer(root, null)?.id).toBe("b")
    expect(findFieldContainer(root, "_root")?.id).toBe("b")
  })

  it("skips a same-named row inside a hidden keep-alive copy", () => {
    const root = html(`
      <div aria-hidden="true"><div data-field="prompt" id="ghost"></div></div>
      <div data-field="prompt" id="real"></div>
    `)
    expect(findFieldContainer(root, "prompt")?.id).toBe("real")
  })

  it("returns null when nothing matches and nothing is invalid", () => {
    const root = html(`<div data-field="a"></div>`)
    expect(findFieldContainer(root, "prompt")).toBeNull()
  })
})

describe("listInvalidFieldContainers", () => {
  it("lists visible invalid rows in document order", () => {
    const root = html(`
      <div data-invalid="true" id="one"></div>
      <div inert><div data-invalid="true" id="hidden"></div></div>
      <div data-invalid="true" id="two"></div>
    `)
    expect(listInvalidFieldContainers(root).map((el) => el.id)).toEqual(["one", "two"])
  })
})

describe("findFieldControl", () => {
  it("prefers text entry over a button in the same row", () => {
    const root = html(`<div id="row"><button id="btn"></button><textarea id="ta"></textarea></div>`)
    expect(findFieldControl(root.querySelector<HTMLElement>("#row")!)?.id).toBe("ta")
  })

  it("falls back to a picker-style control when the row has no text entry", () => {
    const root = html(`<div id="row"><button role="combobox" id="combo"></button></div>`)
    expect(findFieldControl(root.querySelector<HTMLElement>("#row")!)?.id).toBe("combo")
  })

  it("skips disabled and hidden inputs", () => {
    const root = html(`
      <div id="row">
        <input type="hidden" />
        <input disabled />
        <input id="ok" />
      </div>
    `)
    expect(findFieldControl(root.querySelector<HTMLElement>("#row")!)?.id).toBe("ok")
  })

  it("reports an expression editor as not ready until CodeMirror has mounted", () => {
    const root = html(`
      <div id="row">
        <div ${EXPRESSION_FIELD_ATTR}="true" id="expr">
          <button id="picker"></button>
        </div>
      </div>
    `)
    const row = root.querySelector<HTMLElement>("#row")!
    // Not the variable picker: the field has nothing to type into yet.
    expect(findFieldControl(row)).toBeNull()

    const content = document.createElement("div")
    content.className = "cm-content"
    content.setAttribute("contenteditable", "true")
    root.querySelector("#expr")!.appendChild(content)
    expect(findFieldControl(row)).toBe(content)
  })
})

describe("focusFieldControl", () => {
  it("scrolls the row into view and focuses the control without a second scroll", () => {
    const root = html(`<div id="row"><input id="in" /></div>`)
    const row = root.querySelector<HTMLElement>("#row")!
    const input = root.querySelector<HTMLInputElement>("#in")!
    const scroll = jest.fn()
    row.scrollIntoView = scroll
    const focus = jest.spyOn(input, "focus")
    focusFieldControl(row, input)
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "smooth" })
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(input)
  })
})

describe("focusFieldWhenReady", () => {
  it("focuses immediately when the field is already mounted", () => {
    const root = html(`<div data-field="prompt"><input id="in" /></div>`)
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      ...frames,
    })
    expect(outcomes).toEqual(["focused"])
    expect(document.activeElement?.id).toBe("in")
    expect(frames.pending).toBe(0)
  })

  it("retries per frame until the control mounts", () => {
    const root = html(`<div data-field="prompt"><div ${EXPRESSION_FIELD_ATTR}="true"></div></div>`)
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      ...frames,
    })
    expect(outcomes).toEqual([])
    frames.flush()
    expect(outcomes).toEqual([])

    const content = document.createElement("div")
    content.className = "cm-content"
    content.setAttribute("contenteditable", "true")
    content.tabIndex = 0
    root.querySelector(`[${EXPRESSION_FIELD_ATTR}]`)!.appendChild(content)
    frames.flush()
    expect(outcomes).toEqual(["focused"])
    expect(document.activeElement).toBe(content)
  })

  it("follows a root that appears later (the form was still mounting)", () => {
    let root: HTMLElement | null = null
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      ...frames,
    })
    root = html(`<div data-field="prompt"><input id="late" /></div>`)
    frames.flush()
    expect(outcomes).toEqual(["focused"])
    expect(document.activeElement?.id).toBe("late")
  })

  it("does not act on a root inside a hidden panel", () => {
    const hiddenPanel = html(
      `<div aria-hidden="true"><div id="form"><div data-field="prompt"><input id="in" /></div></div></div>`
    )
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => hiddenPanel.querySelector<HTMLElement>("#form"),
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      maxFrames: 2,
      ...frames,
    })
    while (frames.flush()) {
      /* drain */
    }
    expect(outcomes).toEqual(["fallback"])
    expect(document.activeElement).toBe(document.body)
  })

  it("scrolls to the row when its control never mounts", () => {
    const root = html(
      `<div data-field="prompt" id="row"><div ${EXPRESSION_FIELD_ATTR}="true"></div></div>`
    )
    const row = root.querySelector<HTMLElement>("#row")!
    row.scrollIntoView = jest.fn()
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      maxFrames: 3,
      ...frames,
    })
    let ticks = 0
    while (frames.flush()) ticks += 1
    expect(ticks).toBe(3)
    expect(outcomes).toEqual(["scrolled"])
    expect(row.scrollIntoView).toHaveBeenCalled()
  })

  it("scrolls the form to the top when no row ever matches", () => {
    const root = html(`<div data-field="other"></div>`)
    root.scrollIntoView = jest.fn()
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      maxFrames: 1,
      ...frames,
    })
    while (frames.flush()) {
      /* drain */
    }
    expect(outcomes).toEqual(["fallback"])
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" })
  })

  it("reports a cancel exactly once and stops retrying", () => {
    const root = html(`<div data-field="prompt"><div ${EXPRESSION_FIELD_ATTR}="true"></div></div>`)
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    const cancel = focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      ...frames,
    })
    cancel()
    cancel()
    expect(outcomes).toEqual(["cancelled"])
    expect(frames.pending).toBe(0)
  })

  it("treats a cancel after settling as a no-op", () => {
    const root = html(`<div data-field="prompt"><input /></div>`)
    const outcomes: FieldFocusOutcome[] = []
    const cancel = focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      ...manualFrames(),
    })
    cancel()
    expect(outcomes).toEqual(["focused"])
  })

  it("defaults to a bounded budget of animation frames", () => {
    expect(FIELD_FOCUS_MAX_FRAMES).toBeGreaterThan(0)
    const root = html(`<div data-field="other"></div>`)
    const frames = manualFrames()
    const outcomes: FieldFocusOutcome[] = []
    focusFieldWhenReady({
      getRoot: () => root,
      field: "prompt",
      onSettled: (o) => outcomes.push(o),
      ...frames,
    })
    let ticks = 0
    while (frames.flush()) ticks += 1
    expect(ticks).toBe(FIELD_FOCUS_MAX_FRAMES)
    expect(outcomes).toEqual(["fallback"])
  })
})
