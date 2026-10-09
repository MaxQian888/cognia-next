/** @jest-environment jsdom */

import { isProIdePanePinnedWithin } from "@/lib/codeserver/pane-manager"
import { runShellViewTransition } from "./shell-view-transition"

jest.mock("@/lib/codeserver/pane-manager", () => ({
  isProIdePanePinnedWithin: jest.fn(() => false),
}))

const pinned = jest.mocked(isProIdePanePinnedWithin)

interface TransitionStub {
  ready: Promise<void>
  finished: Promise<void>
  skipTransition: jest.Mock
  resolve: () => void
}

let stubs: TransitionStub[] = []

function installViewTransition(): jest.Mock {
  stubs = []
  const start = jest.fn((update: () => void) => {
    let resolve = () => {}
    const finished = new Promise<void>((r) => {
      resolve = r
    })
    const stub: TransitionStub = {
      ready: Promise.resolve(),
      finished,
      skipTransition: jest.fn(),
      resolve,
    }
    stubs.push(stub)
    update()
    return stub
  })
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start })
  return start
}

function removeViewTransition() {
  Reflect.deleteProperty(document, "startViewTransition")
}

beforeEach(() => {
  pinned.mockReturnValue(false)
  document.documentElement.style.viewTransitionName = ""
})

afterEach(() => {
  removeViewTransition()
  Reflect.deleteProperty(document, "visibilityState")
  document.documentElement.style.viewTransitionName = ""
})

describe("runShellViewTransition", () => {
  it("applies immediately and still runs onDone when View Transitions are unavailable", () => {
    const apply = jest.fn()
    const onDone = jest.fn()
    const cancel = runShellViewTransition({ captures: [], apply, onDone })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(() => cancel()).not.toThrow()
  })

  it("bails out when a pinned Pro IDE webview is inside the scope", () => {
    installViewTransition()
    pinned.mockReturnValue(true)
    const scope = document.createElement("div")
    const apply = jest.fn()
    const onDone = jest.fn()

    runShellViewTransition({ scope, captures: [], apply, onDone })

    expect(document.startViewTransition).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("names every capture, roots the page out, and restores on finish", async () => {
    installViewTransition()
    const a = document.createElement("div")
    const b = document.createElement("div")
    b.style.viewTransitionName = "preexisting"
    document.documentElement.style.viewTransitionName = "root-name"
    const apply = jest.fn()
    const onDone = jest.fn()

    runShellViewTransition({
      captures: [
        { element: a, name: "one" },
        { element: b, name: "two" },
        { element: null, name: "skipped" },
      ],
      apply,
      onDone,
    })

    expect(apply).toHaveBeenCalledTimes(1)
    expect(a.style.viewTransitionName).toBe("one")
    expect(b.style.viewTransitionName).toBe("two")
    expect(document.documentElement.style.viewTransitionName).toBe("none")

    stubs[0].resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(a.style.viewTransitionName).toBe("")
    expect(b.style.viewTransitionName).toBe("preexisting")
    expect(document.documentElement.style.viewTransitionName).toBe("root-name")
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("runs the apply exactly once even if the callback is invoked again", () => {
    let update: (() => void) | undefined
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: jest.fn((cb: () => void) => {
        update = cb
        return {
          ready: new Promise<void>(() => {}),
          finished: new Promise<void>(() => {}),
          skipTransition: jest.fn(),
        }
      }),
    })
    const apply = jest.fn()

    runShellViewTransition({ captures: [], apply })
    update?.()

    expect(apply).toHaveBeenCalledTimes(1)
  })

  it("cancelling skips the transition and settles cleanup once", () => {
    installViewTransition()
    const el = document.createElement("div")
    const onDone = jest.fn()

    const cancel = runShellViewTransition({
      captures: [{ element: el, name: "one" }],
      apply: jest.fn(),
      onDone,
    })

    cancel()
    expect(stubs[0].skipTransition).toHaveBeenCalledTimes(1)
    expect(el.style.viewTransitionName).toBe("")
    expect(onDone).toHaveBeenCalledTimes(1)

    // A second cancel — or a late finish — must not double-run cleanup.
    cancel()
    stubs[0].resolve()
    expect(stubs[0].skipTransition).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("bails out while the document is hidden", () => {
    installViewTransition()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    const el = document.createElement("div")
    const apply = jest.fn()
    const onDone = jest.fn()

    runShellViewTransition({ captures: [{ element: el, name: "one" }], apply, onDone })

    expect(document.startViewTransition).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(el.style.viewTransitionName).toBe("")
  })

  it("absorbs a rejected ready when the browser skips the transition", async () => {
    // WebKit's shape when the page goes hidden: the update still runs,
    // `ready` rejects with InvalidStateError and `finished` resolves.
    const ready = Promise.reject(new DOMException("skipped", "InvalidStateError"))
    const readyCatch = jest.spyOn(ready, "catch")
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: jest.fn((update: () => void) => {
        update()
        return { ready, finished: Promise.resolve(), skipTransition: jest.fn() }
      }),
    })
    const el = document.createElement("div")
    const apply = jest.fn()
    const onDone = jest.fn()

    runShellViewTransition({ captures: [{ element: el, name: "one" }], apply, onDone })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(readyCatch).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(el.style.viewTransitionName).toBe("")
  })

  it("still lands the layout and resets names when startViewTransition throws", () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: jest.fn(() => {
        throw new Error("snapshot unavailable")
      }),
    })
    const el = document.createElement("div")
    const apply = jest.fn()
    const onDone = jest.fn()

    runShellViewTransition({
      captures: [{ element: el, name: "one" }],
      apply,
      onDone,
    })

    expect(apply).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(el.style.viewTransitionName).toBe("")
    expect(document.documentElement.style.viewTransitionName).toBe("")
  })
})

describe("edge-panel transition hold", () => {
  // A fresh module per test: the hold is a module-level count, and the suites
  // above deliberately leave transitions that never settle.
  let runShellViewTransition: typeof import("./shell-view-transition").runShellViewTransition
  let attribute = ""
  beforeEach(() => {
    document.documentElement.removeAttribute("data-shell-view-transition")
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require("./shell-view-transition") as typeof import("./shell-view-transition")
      runShellViewTransition = fresh.runShellViewTransition
      attribute = fresh.SHELL_VIEW_TRANSITION_ATTRIBUTE
    })
  })
  const held = () => document.documentElement.hasAttribute(attribute)

  it("holds the edge panels' own size transitions for the length of the gesture", async () => {
    installViewTransition()
    // Observed inside the update: the commit that arms the edge panels' CSS
    // transitions must already see the hold, or they tween under the snapshot.
    let heldDuringApply = false
    runShellViewTransition({ captures: [], apply: () => (heldDuringApply = held()) })

    expect(heldDuringApply).toBe(true)
    expect(held()).toBe(true)
    stubs[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(held()).toBe(false)
  })

  it("keeps the hold while a second gesture is still running", async () => {
    installViewTransition()
    runShellViewTransition({ captures: [], apply: jest.fn() })
    runShellViewTransition({ captures: [], apply: jest.fn() })

    stubs[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(held()).toBe(true)

    stubs[1].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(held()).toBe(false)
  })

  it("never holds on the instant path, where the CSS tween is the only motion", () => {
    let heldDuringApply = true
    runShellViewTransition({ captures: [], apply: () => (heldDuringApply = held()) })
    expect(heldDuringApply).toBe(false)
    expect(held()).toBe(false)
  })

  it("releases the hold when the transition is cancelled", () => {
    installViewTransition()
    const cancel = runShellViewTransition({ captures: [], apply: jest.fn() })
    cancel()
    expect(held()).toBe(false)
  })
})
