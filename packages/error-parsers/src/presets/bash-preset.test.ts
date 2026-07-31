/**
 * @jest-environment node
 */

import { bashPreset } from "./bash-preset"

describe("bashPreset", () => {
  it("extracts exit code and parses stderr", () => {
    const text = "Command failed with exit code 1\nERROR: file not found"
    const result = bashPreset.parse(text)
    expect(result.parsed).toBe(true)
    expect(result.nodes[0].kind).toBe("exitCode")
    expect(result.nodes[0].exitCode).toBe(1)
    expect(result.nodes.some((n) => n.kind === "log" && n.level === "error")).toBe(true)
  })

  it("extracts signal exit codes (128+)", () => {
    const text = "Command failed with exit code 137\nKilled"
    const result = bashPreset.parse(text)
    expect(result.nodes[0].kind).toBe("exitCode")
    expect(result.nodes[0].exitCode).toBe(137)
  })

  it("parses paths in stderr", () => {
    const text = "exit code 1\nERROR: failed at src/foo.ts:42:9"
    const result = bashPreset.parse(text)
    expect(result.nodes.some((n) => n.kind === "path")).toBe(true)
  })

  it("falls back to default parsing when no exit code", () => {
    const text = "some random error"
    const result = bashPreset.parse(text)
    expect(result.parsed).toBe(false)
    expect(result.nodes[0].kind).toBe("text")
  })

  it("handles 'exited with code' wording", () => {
    const text = "Process exited with code 2"
    const result = bashPreset.parse(text)
    expect(result.nodes[0].kind).toBe("exitCode")
    expect(result.nodes[0].exitCode).toBe(2)
  })

  it("lifts an embedded JSON payload into a tree instead of log lines", () => {
    const text = 'Exit code 1\nerror: jq error\n{"ok": false, "error": {"type": "jq_error"}}'
    const result = bashPreset.parse(text)
    expect(result.parsed).toBe(true)
    // Exit code is still a badge, the JSON body is a single tree node...
    expect(result.nodes[0].kind).toBe("exitCode")
    const json = result.nodes.find((n) => n.kind === "json")
    expect((json!.value as { ok: boolean }).ok).toBe(false)
    // ...and the JSON did not leak out as per-line log nodes.
    expect(result.nodes.filter((n) => n.kind === "log")).toHaveLength(1)
  })
})
