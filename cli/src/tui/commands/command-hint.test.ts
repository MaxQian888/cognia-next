/**
 * @jest-environment node
 */
import { buildCommandHint } from "./command-hint"
import { __resetForTesting, registerCommand } from "./registry"

const noop = () => ({ kind: "none" }) as const

beforeEach(() => {
  __resetForTesting()
  registerCommand({
    name: "goal",
    description: "goal loop",
    category: "cognia",
    argumentHint: "<objective | status | pause | resume | stop | list>",
    subcommands: [
      { name: "status", description: "show status", handler: noop },
      {
        name: "add",
        description: "add",
        argumentHint: "<text>",
        handler: noop,
      },
    ],
  })
})

describe("buildCommandHint", () => {
  it("shows the root argumentHint once a space is typed", () => {
    expect(buildCommandHint("/goal ")).toBe(
      "/goal <objective | status | pause | resume | stop | list>"
    )
  })

  it("returns null before a space (slash-palette territory)", () => {
    expect(buildCommandHint("/go")).toBeNull()
    expect(buildCommandHint("/goal")).toBeNull()
  })

  it("shows a subcommand's argumentHint when the first token matches", () => {
    expect(buildCommandHint("/goal add ")).toBe("/goal add <text>")
  })

  it("returns null for a subcommand with no args/hint", () => {
    expect(buildCommandHint("/goal status")).toBeNull()
  })

  it("returns null for an unknown command", () => {
    expect(buildCommandHint("/unknown ")).toBeNull()
  })

  it("returns null for a non-slash line", () => {
    expect(buildCommandHint("hello world")).toBeNull()
  })

  it("falls back to the root hint when the first token is not a subcommand", () => {
    expect(buildCommandHint("/goal frobnicate")).toBe(
      "/goal <objective | status | pause | resume | stop | list>"
    )
  })

  it("derives a hint from a core command's argumentHint (/copy)", () => {
    expect(buildCommandHint("/copy ")).toBe("/copy [n|code|tool|user]")
  })

  it("returns null when a core command has no hint (/clear)", () => {
    expect(buildCommandHint("/clear ")).toBeNull()
  })
})
