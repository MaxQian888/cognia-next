import "./executors"
import { getExecutor } from "../registry"

describe("mobile-nodes registration", () => {
  it.each([
    ["action.approval.request", 1],
    ["action.mobile.camera", 1],
    ["action.mobile.location", 1],
    ["action.mobile.notify", 1],
    ["action.mobile.scanBarcode", 1],
    ["action.mobile.share", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
