/**
 * The bundle entry is three statements of process plumbing. This suite
 * pins that it forwards argv, writes exactly the JSON `runMain` produced,
 * and propagates the exit code — the wire contract the Rust side parses.
 */

const mockRunMain = jest.fn()

jest.mock("./cli", () => ({ runMain: (...args: unknown[]) => mockRunMain(...args) }))
jest.mock("./node-io", () => ({ nodeIo: { marker: "node-io" } }))

describe("bin entry", () => {
  const originalArgv = process.argv
  let written: string[]

  beforeEach(() => {
    jest.resetModules()
    written = []
    mockRunMain.mockReset()
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    process.exitCode = undefined
  })

  afterEach(() => {
    process.argv = originalArgv
    process.exitCode = undefined
    jest.restoreAllMocks()
  })

  it("forwards argv after the node binary and script path", async () => {
    process.argv = ["/usr/bin/node", "/tmp/plugin-convert.mjs", "--from", "cli", "--input", "rg"]
    mockRunMain.mockReturnValue({ output: "{}", exitCode: 0 })

    await import("./bin")

    expect(mockRunMain).toHaveBeenCalledWith(["--from", "cli", "--input", "rg"], {
      marker: "node-io",
    })
  })

  it("writes the payload verbatim and leaves the exit code at 0 on success", async () => {
    process.argv = ["node", "bin", "--list"]
    mockRunMain.mockReturnValue({ output: '{"ok":true}', exitCode: 0 })

    await import("./bin")

    expect(written).toEqual(['{"ok":true}'])
    expect(process.exitCode).toBe(0)
  })

  it("propagates a failure exit code", async () => {
    process.argv = ["node", "bin"]
    mockRunMain.mockReturnValue({ output: '{"ok":false,"error":"x"}', exitCode: 1 })

    await import("./bin")

    expect(process.exitCode).toBe(1)
  })
})
