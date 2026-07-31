// Outside-the-browser guard for the canvas Dexie bridge, split out of
// `dexie-bridge.test.ts`: that file is jsdom-docblocked, and from Node 26 on
// jsdom's `window` is non-configurable, so `delete global.window` throws. This
// file runs in the `node` project, where there is genuinely no window.
//
// The collaborators are stubbed only so the module graph loads; the assertion
// is that NONE of them are touched when there is no window.

const getDb = jest.fn()
const subscribeArtifacts = jest.fn()
const subscribeComments = jest.fn()

jest.mock("@/lib/db/schema", () => ({ getDb: () => getDb() }))
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    subscribe: (...a: unknown[]) => subscribeArtifacts(...a),
    getState: () => ({}),
  },
}))
jest.mock("@/stores/canvas/comment-store", () => ({
  useCommentStore: {
    subscribe: (...a: unknown[]) => subscribeComments(...a),
    getState: () => ({}),
  },
}))
jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

describe("startCanvasDexieBridge outside the browser", () => {
  it("has no window to begin with", () => {
    expect(typeof window).toBe("undefined")
  })

  it("returns a usable noop disposer and subscribes to nothing", async () => {
    const { startCanvasDexieBridge } = await import("./dexie-bridge")
    const dispose = startCanvasDexieBridge()
    expect(typeof dispose).toBe("function")
    expect(() => dispose()).not.toThrow()
    expect(getDb).not.toHaveBeenCalled()
    expect(subscribeArtifacts).not.toHaveBeenCalled()
    expect(subscribeComments).not.toHaveBeenCalled()
  })
})
