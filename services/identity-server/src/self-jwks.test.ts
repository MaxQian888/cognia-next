import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { resetOwnJwks, serveOwnJwks } from "./self-jwks"

// The wrapper keeps whatever `fetch` was in place when it was installed as
// "the network"; a fake one records what would have left the Worker.
const network = vi.fn(async () => new Response("from the network"))

describe("serveOwnJwks", () => {
  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(network as unknown as typeof fetch)
  })
  afterEach(() => {
    resetOwnJwks()
    network.mockClear()
  })

  it("answers exactly the registered URL in-process", async () => {
    serveOwnJwks("https://id.self.test/api/auth/jwks", async () => ({ keys: [{ kid: "k1" }] }))
    expect(await (await fetch("https://id.self.test/api/auth/jwks")).json()).toEqual({
      keys: [{ kid: "k1" }],
    })
    expect((await fetch(new Request("https://id.self.test/api/auth/jwks"))).status).toBe(200)
    expect(network).not.toHaveBeenCalled()
  })

  it("passes other URLs and other methods through to the network", async () => {
    serveOwnJwks("https://id.self.test/api/auth/jwks", async () => ({ keys: [] }))
    expect(await (await fetch("https://id.self.test/api/auth/jwks/extra")).text()).toBe(
      "from the network"
    )
    await fetch("https://id.self.test/api/auth/jwks", { method: "POST" })
    await fetch("https://elsewhere.test/jwks")
    expect(network).toHaveBeenCalledTimes(3)
  })

  it("stops answering once forgotten", async () => {
    serveOwnJwks("https://id.self.test/api/auth/jwks", async () => ({ keys: [] }))
    resetOwnJwks()
    await fetch("https://id.self.test/api/auth/jwks")
    expect(network).toHaveBeenCalledTimes(1)
  })
})
