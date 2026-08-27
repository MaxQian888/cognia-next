/** @jest-environment jsdom */

import { createHash, webcrypto } from "node:crypto"

import { fetchAndVerifyBrowserBuiltinAsset } from "./browser-builtin-assets"

const code = "module.exports = { activate() {} }"
const sha256 = createHash("sha256").update(code).digest("hex")
const asset = {
  url: "/_cognia/builtin-plugins/demo/demo.cjs",
  sha256,
  sharedModules: [],
} as const

function mockResponse(
  body: string,
  status = 200
): Pick<Response, "ok" | "status" | "statusText" | "arrayBuffer"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

describe("fetchAndVerifyBrowserBuiltinAsset", () => {
  it("returns code only after the content hash matches", async () => {
    const fetcher = jest.fn().mockResolvedValue(mockResponse(code))

    await expect(fetchAndVerifyBrowserBuiltinAsset(asset, fetcher, webcrypto.subtle)).resolves.toBe(
      code
    )
    expect(fetcher).toHaveBeenCalledWith(asset.url)
  })

  it("rejects modified code", async () => {
    const fetcher = jest.fn().mockResolvedValue(mockResponse(`${code}\nmodified`))

    await expect(
      fetchAndVerifyBrowserBuiltinAsset(asset, fetcher, webcrypto.subtle)
    ).rejects.toThrow("integrity mismatch")
  })

  it("rejects failed fetches before evaluation", async () => {
    const fetcher = jest.fn().mockResolvedValue(mockResponse("", 404))

    await expect(
      fetchAndVerifyBrowserBuiltinAsset(asset, fetcher, webcrypto.subtle)
    ).rejects.toThrow("404")
  })
})
