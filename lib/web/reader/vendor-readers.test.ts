const extractWithTavily = jest.fn()
const readWithExa = jest.fn()
const fetchWithDeepSeek = jest.fn()
const fetchWithTinyFish = jest.fn()

jest.mock("@cognia/web-search/providers/tavily", () => ({
  extractWithTavily: (...a: unknown[]) => extractWithTavily(...a),
}))
jest.mock("@cognia/web-search/providers/exa", () => ({
  readWithExa: (...a: unknown[]) => readWithExa(...a),
}))
jest.mock("@cognia/web-search/providers/deepseek", () => ({
  fetchWithDeepSeek: (...a: unknown[]) => fetchWithDeepSeek(...a),
}))
jest.mock("@cognia/web-search/providers/tinyfish", () => ({
  fetchWithTinyFish: (...a: unknown[]) => fetchWithTinyFish(...a),
}))

import { ProviderHttpError } from "@cognia/web-search/proxy-search-fetch"
import { classifyVendorStatus, classifyVendorUrlError, readWithVendor } from "./vendor-readers"

const opts = () => ({ signal: new AbortController().signal, attemptBudgetMs: 20_000 })

beforeEach(() => {
  extractWithTavily.mockReset()
  readWithExa.mockReset()
  fetchWithDeepSeek.mockReset()
  fetchWithTinyFish.mockReset()
})

describe("classification", () => {
  it("maps request-level vendor statuses", () => {
    expect(classifyVendorStatus(401)).toBe("vendor-auth")
    expect(classifyVendorStatus(402)).toBe("vendor-quota")
    expect(classifyVendorStatus(432)).toBe("vendor-quota")
    expect(classifyVendorStatus(429)).toBe("vendor-rate-limit")
    expect(classifyVendorStatus(403)).toBe("vendor-refused")
    expect(classifyVendorStatus(504)).toBe("attempt-timeout")
    expect(classifyVendorStatus(undefined)).toBe("vendor-error")
  })

  it("maps per-URL failure tags", () => {
    expect(classifyVendorUrlError("page_not_found")).toBe("not-found")
    expect(classifyVendorUrlError("CRAWL_HTTP_404", 404)).toBe("not-found")
    expect(classifyVendorUrlError("login_required")).toBe("auth-required")
    expect(classifyVendorUrlError("bot_blocked")).toBe("anti-bot")
    expect(classifyVendorUrlError("content_too_large")).toBe("too-large")
    expect(classifyVendorUrlError("CRAWL_TIMEOUT")).toBe("attempt-timeout")
    expect(classifyVendorUrlError("empty_content")).toBe("thin")
  })
})

describe("readWithVendor", () => {
  it("returns reader-service content on success", async () => {
    fetchWithDeepSeek.mockResolvedValueOnce({ title: "T", markdown: "# body" })
    expect(await readWithVendor("deepseek", "https://a.example", "k", opts())).toEqual({
      kind: "content",
      reader: "deepseek",
      source: "deepseek",
      text: "# body",
      title: "T",
      contentType: "text/markdown",
      status: 200,
      statusSource: "reader-service",
      extraction: "markdown",
    })
  })

  it("never treats a per-URL failure as empty success", async () => {
    fetchWithTinyFish.mockResolvedValueOnce({
      ok: false,
      error: { url: "u", error: "login_required" },
    })
    expect(await readWithVendor("tinyfish", "u", "k", opts())).toMatchObject({
      kind: "failure",
      failure: "auth-required",
    })
    readWithExa.mockResolvedValueOnce({ ok: false, tag: "CRAWL_HTTP_403", httpStatusCode: 403 })
    expect(await readWithVendor("exa", "u", "k", opts())).toMatchObject({ failure: "anti-bot" })
    extractWithTavily.mockResolvedValueOnce({ ok: false, error: "empty_content" })
    expect(await readWithVendor("tavily", "u", "k", opts())).toMatchObject({ failure: "thin" })
  })

  it("classifies a request-level vendor error with its service status", async () => {
    fetchWithDeepSeek.mockRejectedValueOnce(new ProviderHttpError("DeepSeek", 402, "balance"))
    expect(await readWithVendor("deepseek", "u", "k", opts())).toMatchObject({
      kind: "failure",
      failure: "vendor-quota",
      status: 402,
      statusSource: "reader-service",
    })
  })

  it("lets cancellation propagate", async () => {
    const c = new AbortController()
    c.abort()
    fetchWithDeepSeek.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
    await expect(
      readWithVendor("deepseek", "u", "k", { signal: c.signal, attemptBudgetMs: 1 })
    ).rejects.toThrow(/Abort/)
  })
})
