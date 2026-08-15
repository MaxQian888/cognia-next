import enMessages from "@/i18n/messages/en/fileViewer.json"
import zhMessages from "@/i18n/messages/zh-CN/fileViewer.json"
import { FILE_VIEWER_ERROR_CODES, fileViewerErrorMessageKey, isFileViewerErrorCode } from "./types"

describe("file viewer error codes", () => {
  it("maps a code to its message key", () => {
    expect(fileViewerErrorMessageKey("too-large")).toBe("error.tooLarge")
    expect(fileViewerErrorMessageKey("outside-workspace")).toBe("error.outsideWorkspace")
    // Single-word codes need no conversion.
    expect(fileViewerErrorMessageKey("unsupported")).toBe("error.unsupported")
  })

  it("recognises only the declared codes", () => {
    expect(FILE_VIEWER_ERROR_CODES.every(isFileViewerErrorCode)).toBe(true)
    expect(isFileViewerErrorCode("nope")).toBe(false)
    expect(isFileViewerErrorCode(undefined)).toBe(false)
  })

  it("has a translation in both locales for every code", () => {
    // The reason the codes are a list: a new failure mode that reaches a user
    // without a message renders as a raw key, and nothing else would catch it.
    for (const code of FILE_VIEWER_ERROR_CODES) {
      const key = fileViewerErrorMessageKey(code).replace("error.", "")
      expect(Object.keys(enMessages.error)).toContain(key)
      expect(Object.keys(zhMessages.error)).toContain(key)
    }
  })

  it("carries no message for a code that no longer exists", () => {
    const keys = Object.keys(enMessages.error)
    const derived = FILE_VIEWER_ERROR_CODES.map((code) =>
      fileViewerErrorMessageKey(code).replace("error.", "")
    )
    expect(keys.sort()).toEqual(derived.sort())
  })
})
