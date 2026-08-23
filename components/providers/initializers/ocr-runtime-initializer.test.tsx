import { render } from "@testing-library/react"
import { OcrRuntimeInitializer } from "./ocr-runtime-initializer"

const installOcrRuntime = jest.fn()
const warnMock = jest.fn()
const proxyFetch = jest.fn()
jest.mock("@/lib/ocr/runtime", () => ({
  installOcrRuntime: (opts?: unknown) => installOcrRuntime(opts),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => proxyFetch(...args),
}))
jest.mock("@cognia/logging", () => ({
  loggers: {
    shell: { warn: (...a: unknown[]) => warnMock(...a), info: jest.fn(), error: jest.fn() },
  },
}))

beforeEach(() => {
  installOcrRuntime.mockReset()
  installOcrRuntime.mockResolvedValue(undefined)
})

describe("OcrRuntimeInitializer", () => {
  it("installs the OCR runtime once on mount and renders nothing", () => {
    const { container, rerender } = render(<OcrRuntimeInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(installOcrRuntime).toHaveBeenCalledTimes(1)
    rerender(<OcrRuntimeInitializer />)
    expect(installOcrRuntime).toHaveBeenCalledTimes(1)
  })

  it("swallows a boot install failure and logs a warning", async () => {
    warnMock.mockReset()
    installOcrRuntime.mockReset().mockRejectedValueOnce(new Error("boom"))
    expect(() => render(<OcrRuntimeInitializer />)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warnMock).toHaveBeenCalledWith("ocr-runtime: boot install threw", {
      err: expect.any(Error),
    })
  })

  it("installs the proxy-aware transport as the cloud-provider seam", async () => {
    proxyFetch.mockReset().mockResolvedValue(new Response("ok"))
    render(<OcrRuntimeInitializer />)

    const [options] = installOcrRuntime.mock.calls[0] as [{ cloudFetch: typeof fetch }]
    expect(typeof options.cloudFetch).toBe("function")

    // Delegation, not identity: the initializer wraps `proxyFetch` so its
    // narrower option type stays assignable to `typeof fetch`.
    await options.cloudFetch("https://api.mistral.ai/v1/ocr", { method: "POST" })
    expect(proxyFetch).toHaveBeenCalledWith("https://api.mistral.ai/v1/ocr", { method: "POST" })
  })
})
