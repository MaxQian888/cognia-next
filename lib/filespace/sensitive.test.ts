import fixture from "@/crates/cognia-files/fixtures/sensitive-paths.json"

import { isSensitiveDirectory, isSensitiveFileName, isSensitivePath } from "./sensitive"

describe("sensitive floor", () => {
  it.each(fixture.cases)("agrees with the shared conformance case $path", ({ path, sensitive }) => {
    expect(isSensitivePath(path)).toBe(sensitive)
  })

  it("matches names case-insensitively but only for ASCII", () => {
    expect(isSensitiveFileName("ID_RSA")).toBe(true)
    expect(isSensitiveFileName(".Env.Local")).toBe(true)
    expect(isSensitiveFileName("ıd_rsa")).toBe(false)
  })

  it("refuses whole directories and the paired ones only under their parent", () => {
    expect(isSensitiveDirectory(undefined, ".SSH")).toBe(true)
    expect(isSensitiveDirectory(".config", "gcloud")).toBe(true)
    expect(isSensitiveDirectory(undefined, "gcloud")).toBe(false)
    expect(isSensitiveDirectory("other", "gh")).toBe(false)
  })

  it("accepts whole FileSpace paths and backslashes", () => {
    expect(isSensitivePath("/workspace/.aws/config")).toBe(true)
    expect(isSensitivePath("C:\\repo\\.git\\HEAD")).toBe(true)
    expect(isSensitivePath("/workspace/src/index.ts")).toBe(false)
    expect(isSensitivePath("")).toBe(false)
  })
})
