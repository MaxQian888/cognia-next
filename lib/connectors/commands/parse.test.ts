/**
 * Tests for lib/connectors/commands/parse.ts — control-command grammar.
 */

import { parseControlCommand, isReadonlyCommand } from "./parse"

describe("parseControlCommand", () => {
  it("parses a bare known command", () => {
    expect(parseControlCommand("/help")).toEqual({ kind: "known", name: "help", arg: "" })
  })

  it("parses a command with an argument", () => {
    expect(parseControlCommand("/model gpt-5")).toEqual({
      kind: "known",
      name: "model",
      arg: "gpt-5",
    })
  })

  it("lowercases the command name but preserves arg case", () => {
    expect(parseControlCommand("/Model GPT-5-Turbo")).toEqual({
      kind: "known",
      name: "model",
      arg: "GPT-5-Turbo",
    })
  })

  it("preserves provider/model slashes in the argument", () => {
    expect(parseControlCommand("/model anthropic/claude-opus-4-8")).toEqual({
      kind: "known",
      name: "model",
      arg: "anthropic/claude-opus-4-8",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(parseControlCommand("   /mode   auto  ")).toEqual({
      kind: "known",
      name: "mode",
      arg: "auto",
    })
  })

  it("returns unknown for an unrecognised alpha command", () => {
    expect(parseControlCommand("/foobar")).toEqual({ kind: "unknown", name: "foobar" })
  })

  it("does NOT treat a file path as a command", () => {
    expect(parseControlCommand("/home/user/file.txt")).toEqual({ kind: "not-a-command" })
    expect(parseControlCommand("/usr/bin/env node")).toEqual({ kind: "not-a-command" })
  })

  it("does NOT treat a bare slash as a command", () => {
    expect(parseControlCommand("/")).toEqual({ kind: "not-a-command" })
    expect(parseControlCommand("/123")).toEqual({ kind: "not-a-command" })
  })

  it("returns not-a-command for plain text", () => {
    expect(parseControlCommand("hello there")).toEqual({ kind: "not-a-command" })
    expect(parseControlCommand("")).toEqual({ kind: "not-a-command" })
  })

  it("parses /workflow as a known state-changing command", () => {
    expect(parseControlCommand("/workflow Nightly")).toEqual({
      kind: "known",
      name: "workflow",
      arg: "Nightly",
    })
    expect(isReadonlyCommand("workflow")).toBe(false)
  })

  it("parses /goal with a multi-word objective as the arg", () => {
    expect(parseControlCommand("/goal write a haiku about winter")).toEqual({
      kind: "known",
      name: "goal",
      arg: "write a haiku about winter",
    })
    // State-changing (create/pause/stop live under it) → gated, not read-only.
    expect(isReadonlyCommand("goal")).toBe(false)
  })

  it("classifies read-only vs state-changing commands", () => {
    expect(isReadonlyCommand("help")).toBe(true)
    expect(isReadonlyCommand("status")).toBe(true)
    expect(isReadonlyCommand("sessions")).toBe(true)
    expect(isReadonlyCommand("dir")).toBe(true)
    expect(isReadonlyCommand("model")).toBe(false)
    expect(isReadonlyCommand("mode")).toBe(false)
    expect(isReadonlyCommand("new")).toBe(false)
  })
})
