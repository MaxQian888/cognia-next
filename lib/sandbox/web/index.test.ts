import { getWebSandboxService } from "./index"

describe("lib/sandbox/web stub", () => {
  const service = getWebSandboxService()

  test("isAvailable() reports the runtime is not yet shipped", () => {
    expect(service.isAvailable()).toBe(false)
  })

  test("isLanguageSupported() returns false for any language", () => {
    expect(service.isLanguageSupported("python")).toBe(false)
    expect(service.isLanguageSupported("javascript")).toBe(false)
    expect(service.isLanguageSupported("")).toBe(false)
  })

  test("execute() resolves to an explanatory error envelope", async () => {
    const result = await service.execute({ language: "python", code: "print(1)" })
    expect(result.ok).toBe(false)
    expect(result.durationMs).toBe(0)
    expect(result.error).toContain("Web sandbox is not yet available")
    expect(result.error).toContain("python")
  })

  test("getWebSandboxService() returns the same shared stub instance", () => {
    expect(getWebSandboxService()).toBe(service)
  })
})
