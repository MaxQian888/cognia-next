import en from "@/i18n/messages/en.json"
import zhCN from "@/i18n/messages/zh-CN.json"

import {
  ALL_CODESERVER_ERROR_KEYS,
  CODESERVER_ERROR_CODES,
  CODESERVER_ERROR_KEYS,
  codeServerErrorCode,
  codeServerErrorText,
  describeCodeServerError,
} from "./error-messages"

const t = (key: string) => `t(${key})`

const lookup = (catalogue: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[part]
    return undefined
  }, catalogue)

describe("codeServerErrorCode", () => {
  it("finds the code a host message leads with", () => {
    expect(codeServerErrorCode("CODESERVER_HEALTH_TIMEOUT: port 4 did not answer")).toBe(
      "CODESERVER_HEALTH_TIMEOUT"
    )
  })

  it("finds it behind an Error prefix and inside an anyhow chain", () => {
    expect(codeServerErrorCode(new Error("CODESERVER_DOWNLOAD_FAILED: https://x: timed out"))).toBe(
      "CODESERVER_DOWNLOAD_FAILED"
    )
    expect(codeServerErrorCode("Error: CODESERVER_CHECKSUM_MISMATCH: expected a, got b")).toBe(
      "CODESERVER_CHECKSUM_MISMATCH"
    )
  })

  it("reads the code a companion RPC error carries beside its message", () => {
    expect(codeServerErrorCode({ code: "CODESERVER_NOT_RUNNING", message: "gone" })).toBe(
      "CODESERVER_NOT_RUNNING"
    )
    expect(codeServerErrorText({ code: "CODESERVER_NOT_RUNNING", message: "gone" })).toBe(
      "CODESERVER_NOT_RUNNING: gone"
    )
  })

  it("ignores a lookalike that is not a known code", () => {
    expect(codeServerErrorCode("CODESERVER_EVENTS were dropped")).toBeNull()
    expect(
      codeServerErrorCode({ code: "service_unavailable", message: "socket closed" })
    ).toBeNull()
    expect(codeServerErrorCode(undefined)).toBeNull()
  })
})

describe("describeCodeServerError", () => {
  it("maps a known code to its message and next step, without the raw text", () => {
    expect(describeCodeServerError("CODESERVER_SPAWN_FAILED: EACCES", t)).toEqual({
      code: "CODESERVER_SPAWN_FAILED",
      message: "t(spawnFailed.message)",
      hint: "t(spawnFailed.hint)",
      detail: null,
    })
  })

  it("keeps the raw text for a failure nobody classified", () => {
    expect(describeCodeServerError(new Error("socket hang up"), t)).toEqual({
      code: null,
      message: "t(unknown.message)",
      hint: "t(unknown.hint)",
      detail: "socket hang up",
    })
  })
})

describe("catalogues", () => {
  it("gives every code its own key", () => {
    const keys = CODESERVER_ERROR_CODES.map((code) => CODESERVER_ERROR_KEYS[code])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it.each([
    ["en", en],
    ["zh-CN", zhCN],
  ])("%s has a message and a hint for every code", (_locale, catalogue) => {
    for (const key of ALL_CODESERVER_ERROR_KEYS) {
      const value = lookup(catalogue, `projectEditor.proIde.errors.${key}`)
      expect({ key, ok: typeof value === "string" && value.length > 0 }).toEqual({ key, ok: true })
    }
  })
})
