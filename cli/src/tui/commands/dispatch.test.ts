/**
 * @jest-environment node
 */
import { dispatchCommand, parseCommandLine, resolveSubcommand } from "./dispatch"
import { __resetForTesting, registerCommand } from "./registry"
import type { CommandContext, CommandDescriptor } from "./types"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { TuiState } from "../state/types"

function ctx(args: string): CommandContext {
  return {
    state: {} as TuiState,
    config: { ...DEFAULT_RESOLVED_CONFIG, cwd: "/w" },
    version: "9.9.9",
    args,
  }
}

const noop = () => ({ kind: "none" }) as const

beforeEach(() => __resetForTesting())

describe("parseCommandLine", () => {
  it("splits a slash line into name + rest", () => {
    expect(parseCommandLine("/goal pause now")).toEqual({ name: "goal", rest: "pause now" })
    expect(parseCommandLine("  /clear  ")).toEqual({ name: "clear", rest: "" })
  })
  it("returns null for a non-slash line", () => {
    expect(parseCommandLine("hello")).toBeNull()
  })
})

describe("resolveSubcommand", () => {
  const desc: CommandDescriptor = {
    name: "goal",
    description: "",
    category: "cognia",
    subcommands: [{ name: "status", description: "", handler: noop }],
  }
  it("matches a subcommand by name, case-insensitively", () => {
    expect(resolveSubcommand(desc, "STATUS")?.name).toBe("status")
  })
  it("returns undefined for an unknown token", () => {
    expect(resolveSubcommand(desc, "frob")).toBeUndefined()
  })
})

describe("dispatchCommand", () => {
  it("reports an unknown command", () => {
    expect(dispatchCommand("/bogus extra", ctx("extra"))).toEqual({
      kind: "notice",
      message: expect.stringContaining("Unknown command /bogus"),
    })
  })

  it("runs a core command's pure handler", () => {
    expect(dispatchCommand("/exit", ctx(""))).toEqual({ kind: "exit" })
    expect(dispatchCommand("/help", ctx(""))).toEqual({
      kind: "openOverlay",
      overlay: { kind: "help" },
    })
  })

  it("routes a matching subcommand to its handler with the remaining args", () => {
    let seen = ""
    registerCommand({
      name: "goal",
      description: "",
      category: "cognia",
      subcommands: [
        {
          name: "pause",
          description: "",
          handler: (c) => {
            seen = c.args
            return { kind: "notice", message: "paused" }
          },
        },
      ],
    })
    expect(dispatchCommand("/goal pause hard", ctx("pause hard"))).toEqual({
      kind: "notice",
      message: "paused",
    })
    expect(seen).toBe("hard")
  })

  it("opens a form when a subcommand needs args that were not supplied inline", () => {
    registerCommand({
      name: "mcp",
      description: "",
      category: "mcp",
      subcommands: [
        {
          name: "add",
          description: "",
          args: [{ name: "name", label: "Name", type: "string", required: true }],
          handler: noop,
        },
      ],
    })
    expect(dispatchCommand("/mcp add", ctx("add"))).toEqual({
      kind: "openForm",
      form: {
        title: expect.stringContaining("mcp add"),
        commandName: "mcp",
        subcommand: "add",
        specs: [{ name: "name", label: "Name", type: "string", required: true }],
      },
    })
  })

  it("runs the subcommand handler when inline args are present", () => {
    registerCommand({
      name: "mcp",
      description: "",
      category: "mcp",
      subcommands: [
        {
          name: "add",
          description: "",
          args: [{ name: "name", label: "Name", type: "string", required: true }],
          handler: (c) => ({ kind: "notice", message: `added ${c.args}` }),
        },
      ],
    })
    expect(dispatchCommand("/mcp add --name srv", ctx("add --name srv"))).toEqual({
      kind: "notice",
      message: "added --name srv",
    })
  })

  it("falls through to the root handler when the first token is not a subcommand", () => {
    registerCommand({
      name: "goal",
      description: "",
      category: "cognia",
      handler: (c) => ({
        kind: "runtime",
        runtime: { feature: "goal", action: "start", arg: c.args },
      }),
      subcommands: [{ name: "status", description: "", handler: noop }],
    })
    expect(dispatchCommand("/goal buy milk", ctx("buy milk"))).toEqual({
      kind: "runtime",
      runtime: { feature: "goal", action: "start", arg: "buy milk" },
    })
  })

  it("notes an unknown subcommand when the root has no handler", () => {
    registerCommand({
      name: "team",
      description: "",
      category: "cognia",
      subcommands: [{ name: "list", description: "", handler: noop }],
    })
    const eff = dispatchCommand("/team frobnicate", ctx("frobnicate"))
    expect(eff.kind).toBe("notice")
    expect((eff as { message: string }).message).toContain("list")
  })

  it("opens a form for a bare command whose root declares args and has no handler", () => {
    registerCommand({
      name: "note",
      description: "",
      category: "system",
      args: [{ name: "text", label: "Text", type: "string", required: true, style: "positional" }],
    })
    expect(dispatchCommand("/note", ctx(""))).toMatchObject({
      kind: "openForm",
      form: { commandName: "note" },
    })
  })

  it("notes usage for a bare command with only subcommands and no handler", () => {
    registerCommand({
      name: "team",
      description: "",
      category: "cognia",
      subcommands: [{ name: "list", description: "", handler: noop }],
    })
    const eff = dispatchCommand("/team", ctx(""))
    expect(eff.kind).toBe("notice")
    expect((eff as { message: string }).message).toContain("list")
  })

  it("keeps /mode and /model distinct (no prefix collision in dispatch)", () => {
    expect(dispatchCommand("/mode", ctx("")).kind).toBe("openOverlay")
    expect(dispatchCommand("/model", ctx("")).kind).toBe("openOverlay")
  })
})
