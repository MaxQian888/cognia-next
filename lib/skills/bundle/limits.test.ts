import {
  MAX_RESOURCES_PER_SKILL,
  MAX_RESOURCE_BYTES_DISK,
  MAX_RESOURCE_BYTES_WEB,
  MAX_ZIP_TOTAL_BYTES,
  validateDirName,
  validateResourcePath,
} from "./limits"

describe("bundle limits", () => {
  it("exposes the Rust-side caps so the loader stays in lock-step", () => {
    expect(MAX_ZIP_TOTAL_BYTES).toBe(200 * 1024 * 1024)
    expect(MAX_RESOURCE_BYTES_WEB).toBe(16 * 1024 * 1024)
    expect(MAX_RESOURCE_BYTES_DISK).toBe(2 * 1024 * 1024)
    expect(MAX_RESOURCES_PER_SKILL).toBe(50)
  })

  it("web cap is strictly larger than disk cap so the warning surfaces a real downgrade", () => {
    expect(MAX_RESOURCE_BYTES_WEB).toBeGreaterThan(MAX_RESOURCE_BYTES_DISK)
  })
})

describe("validateResourcePath", () => {
  it.each([
    ["scripts/foo.sh", null],
    ["references/notes.md", null],
    ["assets/icon.png", null],
    ["nested/deep/file.txt", null],
  ])("accepts %s", (path, expected) => {
    expect(validateResourcePath(path)).toBe(expected)
  })

  it("rejects empty paths", () => {
    expect(validateResourcePath("")).toMatch(/empty/)
  })

  it("rejects path traversal", () => {
    expect(validateResourcePath("../etc/passwd")).toMatch(/traversal/)
    expect(validateResourcePath("scripts/../etc/passwd")).toMatch(/traversal/)
  })

  it("rejects absolute paths", () => {
    expect(validateResourcePath("/etc/passwd")).toMatch(/absolute/)
    expect(validateResourcePath("\\Windows\\System32")).toMatch(/absolute/)
  })

  it("rejects single-dot segments and empty segments", () => {
    expect(validateResourcePath("./scripts/foo.sh")).toMatch(/invalid segment/)
    expect(validateResourcePath("scripts//foo.sh")).toMatch(/invalid segment/)
  })
})

describe("validateDirName", () => {
  it.each(["code-review", "data_export", "abc123", "A"])("accepts %s", (name) => {
    expect(validateDirName(name)).toBeNull()
  })

  it("rejects empty", () => {
    expect(validateDirName("")).toMatch(/empty/)
  })

  it("rejects names longer than 64 chars", () => {
    expect(validateDirName("a".repeat(65))).toMatch(/too long/)
  })

  it("rejects leading or trailing dash", () => {
    expect(validateDirName("-abc")).toMatch(/start or end/)
    expect(validateDirName("abc-")).toMatch(/start or end/)
  })

  it("rejects punctuation and spaces", () => {
    expect(validateDirName("hello world")).toMatch(/invalid character/)
    expect(validateDirName("hello.md")).toMatch(/invalid character/)
    expect(validateDirName("héllo")).toMatch(/invalid character/)
  })
})
