import {
  CLEAR_SCREEN,
  clearTerminal,
  userMessageStats,
  readThemeFile,
  baseName,
} from "./app-helpers"

describe("userMessageStats", () => {
  const cells = [
    { kind: "user" }, // index 0 → pos 1
    { kind: "assistant" },
    { kind: "user" }, // index 2 → pos 2
    { kind: "tool" },
    { kind: "user" }, // index 4 → pos 3
  ]

  it("reports the 1-based position, total, and later count", () => {
    expect(userMessageStats(cells, 2)).toEqual({ pos: 2, total: 3, later: 1 })
  })

  it("handles the first user message", () => {
    expect(userMessageStats(cells, 0)).toEqual({ pos: 1, total: 3, later: 2 })
  })

  it("handles the last user message", () => {
    expect(userMessageStats(cells, 4)).toEqual({ pos: 3, total: 3, later: 0 })
  })

  it("returns pos 0 when the index is not a user cell", () => {
    expect(userMessageStats(cells, 1)).toEqual({ pos: 0, total: 3, later: 3 })
  })

  it("handles an empty transcript", () => {
    expect(userMessageStats([], 0)).toEqual({ pos: 0, total: 0, later: 0 })
  })
})

describe("baseName", () => {
  it("returns the last segment for a POSIX path", () => {
    expect(baseName("/home/user/project")).toBe("project")
  })

  it("returns the last segment for a Windows path", () => {
    expect(baseName("C:\\Users\\me\\cognia-next")).toBe("cognia-next")
  })

  it("tolerates trailing separators", () => {
    expect(baseName("/a/b/c/")).toBe("c")
  })

  it("returns the input when there is no separator", () => {
    expect(baseName("solo")).toBe("solo")
  })

  it("returns the input for an all-separator string", () => {
    expect(baseName("///")).toBe("///")
  })
})

describe("readThemeFile", () => {
  it("reads an existing file", () => {
    // package.json is guaranteed to exist at the cli root.
    const body = readThemeFile(`${__dirname}/app-helpers.ts`)
    expect(body).toContain("baseName")
  })

  it("returns null for a missing file", () => {
    expect(readThemeFile(`${__dirname}/does-not-exist.json`)).toBeNull()
  })
})

describe("clearTerminal", () => {
  const realIsTTY = process.stdout.isTTY

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: realIsTTY, configurable: true })
    jest.restoreAllMocks()
  })

  it("writes the clear-screen escape when stdout is a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    const write = jest.spyOn(process.stdout, "write").mockReturnValue(true)
    clearTerminal()
    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN)
  })

  it("does nothing when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    const write = jest.spyOn(process.stdout, "write").mockReturnValue(true)
    clearTerminal()
    expect(write).not.toHaveBeenCalled()
  })
})
