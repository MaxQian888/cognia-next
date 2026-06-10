/**
 * @jest-environment node
 */
import { main, VERSION } from "./index"
import type { OutputSink } from "./output"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (t) => stdout.push(t),
    error: (t) => stderr.push(t),
    json: () => undefined,
  }
  return { out, stdout: () => stdout.join(""), stderr: () => stderr.join("") }
}

describe("main", () => {
  it("prints the version", async () => {
    const s = sink()
    expect(await main(["--version"], { out: s.out })).toBe(0)
    expect(s.stdout()).toBe(`${VERSION}\n`)
  })

  it("prints help on --help (exit 0)", async () => {
    const s = sink()
    expect(await main(["--help"], { out: s.out })).toBe(0)
    expect(s.stdout()).toMatch(/Usage:/)
  })

  it("prints help to stderr with exit 2 when no command", async () => {
    const s = sink()
    expect(await main([], { out: s.out })).toBe(2)
    expect(s.stderr()).toMatch(/Usage:/)
  })

  it("dispatches run", async () => {
    const s = sink()
    const run = jest.fn().mockResolvedValue(0)
    expect(await main(["run", "hi"], { out: s.out, run })).toBe(0)
    expect(run).toHaveBeenCalled()
    expect(run.mock.calls[0][0].command).toBe("run")
  })

  it("dispatches auth", async () => {
    const auth = jest.fn().mockResolvedValue(0)
    await main(["auth", "status"], { auth })
    expect(auth.mock.calls[0][0].subcommand).toBe("status")
  })

  it("dispatches config", async () => {
    const config = jest.fn().mockResolvedValue(0)
    await main(["config", "path"], { config })
    expect(config.mock.calls[0][0].subcommand).toBe("path")
  })

  it("dispatches handoff", async () => {
    const handoff = jest.fn().mockResolvedValue(0)
    await main(["handoff", "s1"], { handoff })
    expect(handoff.mock.calls[0][0].command).toBe("handoff")
    expect(handoff.mock.calls[0][0].positionals).toEqual(["s1"])
  })

  it("dispatches resume", async () => {
    const resume = jest.fn().mockResolvedValue(0)
    await main(["resume", "s1", "go on"], { resume })
    expect(resume.mock.calls[0][0].command).toBe("resume")
  })

  it("dispatches chat", async () => {
    const chat = jest.fn().mockResolvedValue(0)
    await main(["chat"], { chat })
    expect(chat.mock.calls[0][0].command).toBe("chat")
  })

  it("errors with exit 2 on an unknown command", async () => {
    const s = sink()
    expect(await main(["frobnicate"], { out: s.out })).toBe(2)
    expect(s.stderr()).toMatch(/unknown command "frobnicate"/)
  })
})
