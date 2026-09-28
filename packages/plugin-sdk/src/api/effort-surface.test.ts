import { resolveEffortSurface } from "@/lib/ai/effort-surface"

beforeEach(() => jest.resetModules())

test("requires a host binding and delegates snapshot, subscription and cleanup to it", async () => {
  const facade = await import("./effort-surface")
  expect(() => facade.effortSurfaceForSession(undefined)).toThrow("requires the Cognia host")
  const snapshot = resolveEffortSurface({ runtime: "claude-sdk" })
  const stop = jest.fn()
  const runtime = {
    effortSurfaceForSession: jest.fn(() => snapshot),
    subscribeEffortSurface: jest.fn(() => stop),
  }
  facade.bindEffortSurfaceHost(runtime)
  const session = { id: "fixture-session", model: "fixture-model" }
  expect(facade.effortSurfaceForSession(session)).toBe(snapshot)
  expect(runtime.effortSurfaceForSession).toHaveBeenCalledWith(session)
  const listener = jest.fn()
  expect(facade.subscribeEffortSurface(session.id, listener)).toBe(stop)
  expect(runtime.subscribeEffortSurface).toHaveBeenCalledWith(session.id, listener)
})
