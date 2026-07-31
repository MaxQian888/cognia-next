/**
 * Tests for the native PDF bridge — Tauri `parse_document_native` invoke
 * wrapper with the module-level `unsupported` capability cache.
 */

jest.mock("../runtime-adapters", () => ({
  isTauri: jest.fn(),
  documentTransport: { call: jest.fn() },
}))

import { documentTransport, isTauri } from "../runtime-adapters"
import {
  parsePdfNative,
  __resetNativePdfCapabilityForTests,
  type NativeParseDto,
} from "./native-pdf"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockCall = documentTransport.call as jest.MockedFunction<typeof documentTransport.call>

const DTO: NativeParseDto = {
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      text: "first page",
      items: [{ text: "first", x: 10, y: 20, width: 30, height: 12 }],
      truncated: false,
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      text: "second page",
      items: [],
      truncated: true,
    },
  ],
  text: "native-joined text (ignored by the bridge)",
}

describe("parsePdfNative", () => {
  beforeEach(() => {
    mockIsTauri.mockReset()
    mockCall.mockReset()
    __resetNativePdfCapabilityForTests()
  })

  it("throws without invoking IPC when not running in Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(parsePdfNative(new Uint8Array([1, 2, 3]))).rejects.toThrow(/tauri/i)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("maps the DTO onto PDFParseResult with items and the \\n\\n-joined text invariant", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCall.mockResolvedValue(DTO)

    const result = await parsePdfNative(new Uint8Array([1, 2, 3]), {
      password: "secret",
      targetPages: [1, 2],
    })

    expect(mockCall).toHaveBeenCalledWith("parse_document_native", {
      payload: {
        bytes: expect.anything(),
        password: "secret",
        targetPages: [1, 2],
      },
    })
    // The bridge constructs `text` from page texts so the pdfjs invariant
    // (pages joined with "\n\n") holds on the native path too.
    expect(result.text).toBe("first page\n\nsecond page")
    expect(result.pageCount).toBe(2)
    expect(result.pages[0]).toMatchObject({
      pageNumber: 1,
      text: "first page",
      width: 612,
      height: 792,
      items: [{ text: "first", x: 10, y: 20, width: 30, height: 12 }],
    })
    expect(result.pages[0].itemsTruncated).toBeUndefined()
    expect(result.pages[1].itemsTruncated).toBe(true)
    expect(result.metadata).toEqual({})
  })

  it("caches the `unsupported` capability and skips IPC on later calls", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCall.mockRejectedValue("unsupported")

    await expect(parsePdfNative(new Uint8Array([1]))).rejects.toThrow("unsupported")
    await expect(parsePdfNative(new Uint8Array([1]))).rejects.toThrow("unsupported")
    expect(mockCall).toHaveBeenCalledTimes(1)
  })

  it("rethrows non-capability errors without caching", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCall.mockRejectedValue("parse_failed: boom")

    await expect(parsePdfNative(new Uint8Array([1]))).rejects.toThrow("parse_failed: boom")
    mockCall.mockResolvedValue(DTO)
    await expect(parsePdfNative(new Uint8Array([1]))).resolves.toMatchObject({ pageCount: 2 })
    expect(mockCall).toHaveBeenCalledTimes(2)
  })

  it("rejects a malformed DTO shape", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCall.mockResolvedValue({ nope: true })

    await expect(parsePdfNative(new Uint8Array([1]))).rejects.toThrow(/malformed/i)
  })
})
