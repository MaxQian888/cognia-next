/**
 * Identity resolution. The point of the seam is that identity is HOST-supplied;
 * these assertions pin that the default is a recognizably-unregistered answer
 * rather than a plausible-looking guess.
 */

import {
  resolveInterceptorIdentity,
  setInterceptorIdentityResolver,
  __resetInterceptorIdentityForTesting,
} from "./identity"

afterEach(() => {
  __resetInterceptorIdentityForTesting()
})

describe("resolveInterceptorIdentity", () => {
  it("answers with an unregistered-host identity before a resolver is installed", () => {
    expect(resolveInterceptorIdentity("p1")).toEqual({
      pluginInstanceId: "p1",
      generation: 0,
      realmId: "global",
      runtime: "frontend",
    })
  })

  it("uses the installed resolver", () => {
    setInterceptorIdentityResolver((pluginId) => ({
      pluginInstanceId: `${pluginId}#7`,
      generation: 7,
      realmId: "session:s1",
      runtime: "python",
    }))
    expect(resolveInterceptorIdentity("p1").generation).toBe(7)
    expect(resolveInterceptorIdentity("p1").realmId).toBe("session:s1")
  })

  it("restores the default when the disposer runs", () => {
    const dispose = setInterceptorIdentityResolver(() => ({
      pluginInstanceId: "x",
      generation: 99,
      realmId: "global",
      runtime: "frontend",
    }))
    expect(resolveInterceptorIdentity("p1").generation).toBe(99)
    dispose()
    // A disposed manager whose closure stayed installed would keep answering
    // for leases it no longer owns.
    expect(resolveInterceptorIdentity("p1").generation).toBe(0)
  })
})
