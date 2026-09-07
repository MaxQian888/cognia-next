import { resolveWritePlaneRoute, type WritePlaneRouteInput } from "./write-plane-route"

function input(over: Partial<WritePlaneRouteInput> = {}): WritePlaneRouteInput {
  return {
    isRemoteHostActive: () => false,
    hasLocalExecutor: () => false,
    targetKind: () => undefined,
    ...over,
  }
}

describe("resolveWritePlaneRoute", () => {
  it("routes to the local executor when this process owns it", () => {
    expect(resolveWritePlaneRoute(input({ hasLocalExecutor: () => true }))).toBe("local")
  })

  it("asks about the remote host BEFORE the local executor", () => {
    // The whole reason this ordering is shared. Every "do I have the executor"
    // capability is a static baseline, so a desktop driving a remote Cognia
    // still reports it while its local runtimes are torn down. Routing that
    // shell locally puts the write in a process that will not execute it.
    expect(
      resolveWritePlaneRoute(
        input({ isRemoteHostActive: () => true, hasLocalExecutor: () => true })
      )
    ).toBe("remote")
  })

  it("relays for a companion target that has no executor of its own", () => {
    expect(resolveWritePlaneRoute(input({ targetKind: () => "companion" }))).toBe("remote")
  })

  it("refuses when there is neither an executor nor a target", () => {
    expect(resolveWritePlaneRoute(input())).toBe("unavailable")
    expect(resolveWritePlaneRoute(input({ targetKind: () => "standalone" }))).toBe("unavailable")
  })
})
