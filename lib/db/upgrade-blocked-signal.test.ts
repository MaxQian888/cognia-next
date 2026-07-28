// Deliberately NOT jsdom. The module's whole point is that `lib/db/schema.ts`
// can call it from anywhere, so both halves of the `typeof window` guard need
// coverage — and only the node env can exercise the "no window" half. A bare
// `EventTarget` supplies the three methods the module actually uses, so the
// browser half is still tested here rather than in a second jsdom file.

import {
  DB_UPGRADE_BLOCKED_EVENT,
  dispatchDbUpgradeBlocked,
  subscribeDbUpgradeBlocked,
} from "./upgrade-blocked-signal"

// The repo's global types declare `window` as a non-optional `Window`, so the
// shim goes through `unknown` — this suite deliberately runs where there isn't
// one.
const g = globalThis as unknown as { window?: unknown }

function withWindow(): EventTarget {
  const target = new EventTarget()
  g.window = target
  return target
}

afterEach(() => {
  delete g.window
})

describe("upgrade-blocked-signal", () => {
  it("delivers the detail to subscribers", () => {
    withWindow()
    const handler = jest.fn()
    const off = subscribeDbUpgradeBlocked(handler)

    dispatchDbUpgradeBlocked({ databaseName: "cognia", attempts: 20 })

    expect(handler).toHaveBeenCalledWith({ databaseName: "cognia", attempts: 20 })
    off()
  })

  it("stops delivering after unsubscribe", () => {
    withWindow()
    const handler = jest.fn()
    subscribeDbUpgradeBlocked(handler)()

    dispatchDbUpgradeBlocked({ databaseName: "cognia", attempts: 20 })

    expect(handler).not.toHaveBeenCalled()
  })

  it("ignores a same-named event carrying no detail", () => {
    const target = withWindow()
    const handler = jest.fn()
    const off = subscribeDbUpgradeBlocked(handler)

    target.dispatchEvent(new CustomEvent(DB_UPGRADE_BLOCKED_EVENT))

    expect(handler).not.toHaveBeenCalled()
    off()
  })

  it("no-ops without a window instead of throwing", () => {
    // `getDb()`'s give-up path must stay safe under SSR pre-render and in the
    // node-env test project, where there is no window to dispatch on.
    expect(() => dispatchDbUpgradeBlocked({ databaseName: "cognia", attempts: 20 })).not.toThrow()

    const off = subscribeDbUpgradeBlocked(jest.fn())
    expect(() => off()).not.toThrow()
  })
})
