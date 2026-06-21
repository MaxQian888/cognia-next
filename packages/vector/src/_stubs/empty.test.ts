import stub, { promises, constants } from "./empty"

describe("lib/vector/_stubs/empty (browser stub for Node built-ins)", () => {
  test("default export is a Proxy that throws on unknown property access", () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(stub as any).readFile()
    }).toThrow(/Node built-in API "readFile" is not available/)
  })

  test("`default` lookup returns undefined (avoids Proxy recursion on import interop)", () => {
    expect((stub as Record<string, unknown>).default).toBeUndefined()
  })

  test("symbol property access returns undefined", () => {
    const sym = Symbol("probe")
    expect((stub as unknown as Record<symbol, unknown>)[sym]).toBeUndefined()
  })

  test("named exports `promises` and `constants` mirror the same stub behavior", () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(promises as any).writeFile()
    }).toThrow(/Node built-in API "writeFile" is not available/)
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(constants as any).O_RDONLY()
    }).toThrow(/Node built-in API "O_RDONLY" is not available/)
  })
})
