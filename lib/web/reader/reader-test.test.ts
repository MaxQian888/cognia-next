const readWithVendorMock = jest.fn()
jest.mock("./vendor-readers", () => ({
  readWithVendor: (...a: unknown[]) => readWithVendorMock(...a),
}))

import { OperationAdmission } from "@cognia/web-search/operation-policy"
import { READER_TEST_URL, testReaderConnection } from "./reader-test"

const page = `<html><body><p>${"Example Domain text. ".repeat(20)}</p></body></html>`

function res(body: string, status = 200): Response {
  return {
    ok: status < 400,
    status,
    headers: { get: () => "text/html" },
    text: async () => body,
  } as unknown as Response
}

describe("testReaderConnection", () => {
  it("reads one page through exactly the tested reader, with dated evidence", async () => {
    const fetchImpl = jest.fn(async (_input: RequestInfo | URL) => res(page))
    const r = await testReaderConnection("direct", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 42,
      admission: new OperationAdmission(),
    })
    expect(r).toEqual({ reader: "direct", ok: true, status: 200, testedAt: 42 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe(READER_TEST_URL)
  })

  it("fails a vendor reader without a stored credential and sends nothing", async () => {
    const r = await testReaderConnection("tavily", {
      now: () => 1,
      admission: new OperationAdmission(),
    })
    expect(r).toEqual({ reader: "tavily", ok: false, reason: "reader-unavailable", testedAt: 1 })
    expect(readWithVendorMock).not.toHaveBeenCalled()
  })

  it("never falls back to another reader", async () => {
    readWithVendorMock.mockResolvedValueOnce({
      kind: "failure",
      reader: "exa",
      failure: "vendor-auth",
      detail: "401",
    })
    const fetchImpl = jest.fn(async () => res(page))
    const r = await testReaderConnection("exa", {
      credentialFor: () => "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      admission: new OperationAdmission(),
    })
    expect(r.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reports an empty page as not readable", async () => {
    const fetchImpl = jest.fn(async () => res("", 200))
    const r = await testReaderConnection("direct", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      admission: new OperationAdmission(),
    })
    expect(r).toMatchObject({ ok: false, reason: "no-readable-content" })
  })
})
