import fs from "node:fs"
import path from "node:path"

import { KNOWN_COMMANDS } from "./known-commands"

describe("KNOWN_COMMANDS", () => {
  it("names every arm the dispatcher actually handles", () => {
    // A command added to the switch but not to this set would be treated as a
    // prompt under `-p`, and could be shadowed by a derived resource command.
    const source = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8")
    const arms = [...source.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((match) => match[1])
    const dispatched = new Set(arms.filter((arm) => arm !== "help" && arm !== "version"))
    for (const arm of dispatched) expect(KNOWN_COMMANDS.has(arm)).toBe(true)
    expect(dispatched.size).toBeGreaterThan(20)
  })

  it("claims no name the dispatcher does not handle", () => {
    const source = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8")
    const arms = new Set([...source.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((m) => m[1]))
    for (const name of KNOWN_COMMANDS) expect(arms.has(name)).toBe(true)
  })
})
