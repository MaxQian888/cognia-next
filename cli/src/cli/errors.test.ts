import { EXIT_FAILURE, EXIT_USAGE, emitFailure, renderFailure, usageFailure } from "./errors"
import type { OutputSink } from "./output"

function sink(): OutputSink & { stderr: string[] } {
  const captured = {
    stderr: [] as string[],
    write() {},
    error(text: string) {
      captured.stderr.push(text)
    },
    json() {},
  }
  return captured
}

describe("renderFailure", () => {
  it("emits the blocks in the order a reader scans them", () => {
    const text = renderFailure({
      error: "the host refused plugin_uninstall",
      details: ["HTTP 403"],
      cause: "refused",
      fix: ["grant plugin.manage in the Device Console"],
      inspect: ["cognia-agent api describe plugin_uninstall"],
      diagnostics: { status: 403, requestId: "req_1" },
    })
    expect(text.trimEnd().split("\n")).toEqual([
      "Error: the host refused plugin_uninstall",
      "Details: HTTP 403",
      "Cause: refused",
      "Fix: grant plugin.manage in the Device Console",
      "Inspect: cognia-agent api describe plugin_uninstall",
      "Diagnostics: status=403",
      "Diagnostics: requestId=req_1",
    ])
  })

  it("omits blocks with nothing to say", () => {
    expect(renderFailure({ error: "boom", cause: "network" }).trimEnd().split("\n")).toEqual([
      "Error: boom",
      "Cause: network",
    ])
  })

  it("drops empty and undefined diagnostics rather than printing blanks", () => {
    const text = renderFailure({
      error: "boom",
      cause: "network",
      diagnostics: { status: 500, requestId: undefined, logId: "" },
    })
    expect(text).toContain("Diagnostics: status=500")
    expect(text).not.toContain("requestId")
    expect(text).not.toContain("logId")
  })

  it("keeps every fix and inspect line instead of collapsing them", () => {
    const text = renderFailure({
      error: "boom",
      cause: "no-host",
      fix: ["set COGNIA_SERVER_URL", "or run cognia-agent host add"],
      inspect: ["cognia-agent host show", "cognia-agent host list"],
    })
    expect(text.match(/^Fix: /gm)).toHaveLength(2)
    expect(text.match(/^Inspect: /gm)).toHaveLength(2)
  })
})

describe("emitFailure", () => {
  it("writes to stderr and returns the failure exit code", () => {
    const out = sink()
    expect(emitFailure(out, { error: "boom", cause: "failed" })).toBe(EXIT_FAILURE)
    expect(out.stderr[0]).toContain("Error: boom")
  })

  it("honours an explicit exit code", () => {
    expect(emitFailure(sink(), { error: "boom", cause: "failed" }, 7)).toBe(7)
  })
})

describe("usageFailure", () => {
  it("classifies as invalid-request and exits 2", () => {
    const out = sink()
    expect(usageFailure(out, "missing <command>", ["cognia-agent api call plugin_list"])).toBe(
      EXIT_USAGE
    )
    expect(out.stderr[0]).toContain("Cause: invalid-request")
    expect(out.stderr[0]).toContain("Fix: cognia-agent api call plugin_list")
  })

  it("leaves the inspect block out when no probe was offered", () => {
    const out = sink()
    usageFailure(out, "missing <command>", ["do the thing"])
    expect(out.stderr[0]).not.toContain("Inspect:")
  })
})
