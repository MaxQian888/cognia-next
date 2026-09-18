/** @jest-environment jsdom */

import { isProIdePanePinnedWithin } from "@/lib/codeserver/pane-manager"
import { runShellViewTransition } from "./shell-view-transition"

jest.mock("@/lib/codeserver/pane-manager", () => ({
  isProIdePanePinnedWithin: jest.fn(() => false),
}))

const pinned = jest.mocked(isProIdePanePinnedWithin)

interface TransitionStub {
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
    const stub: TransitionStub = { finished, skipTransition: jest.fn(), resolve }
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
