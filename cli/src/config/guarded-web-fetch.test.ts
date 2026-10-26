import type { LookupAddress } from "node:dns"

import {
  createGuardedLookup,
  createGuardedWebFetch,
  PrivateAddressError,
} from "./guarded-web-fetch"

function resolver(addresses: LookupAddress[]) {
  return (
    _host: string,
    _opts: unknown,
    cb: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
  ) => cb(null, addresses)
}

function run(lookup: ReturnType<typeof createGuardedLookup>, all = false) {
  return new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) =>
    lookup("example.test", { all }, (error, address, family) => resolve({ error, address, family }))
  )
}

describe("createGuardedLookup", () => {
  it("passes public addresses through in both lookup shapes", async () => {
    const addresses = [{ address: "93.184.216.34", family: 4 }]
    const lookup = createGuardedLookup({ resolve: resolver(addresses) })
    expect(await run(lookup)).toEqual({ error: null, address: "93.184.216.34", family: 4 })
    expect(await run(lookup, true)).toEqual({ error: null, address: addresses, family: undefined })
  })

  it("refuses a public name that resolves to any non-public address", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      const lookup = createGuardedLookup({
        resolve: resolver([
          { address: "93.184.216.34", family: 4 },
          { address, family: address.includes(":") ? 6 : 4 },
        ]),
      })
      const { error } = await run(lookup)
      expect(error).toBeInstanceOf(PrivateAddressError)
    }
  })

  it("allows private addresses only when the host allows private hosts", async () => {
    const lookup = createGuardedLookup({
      allowPrivateHosts: true,
      resolve: resolver([{ address: "127.0.0.1", family: 4 }]),
    })
    expect((await run(lookup)).error).toBeNull()
  })

  it("propagates resolution failures", async () => {
    const lookup = createGuardedLookup({
      resolve: (_h, _o, cb) => cb(Object.assign(new Error("nx"), { code: "ENOTFOUND" }), []),
    })
    expect((await run(lookup)).error?.message).toBe("nx")
  })
})

describe("createGuardedWebFetch", () => {
  it("refuses to connect to a name that resolves to loopback", async () => {
    const guardedFetch = createGuardedWebFetch({
      resolve: resolver([{ address: "127.0.0.1", family: 4 }]),
    })
    const error = await guardedFetch("http://rebind.example.test/").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error & { cause?: unknown }).cause ?? error)).toMatch(/non-public/)
  })
})
