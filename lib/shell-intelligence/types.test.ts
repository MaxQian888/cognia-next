import {
  COMPLETION_DEBOUNCE_MS,
  COMPLETION_KIND_PRIORITY,
  DIAGNOSTIC_IDLE_MS,
  DIAGNOSTIC_MIN_LENGTH,
  MAX_COMPLETIONS,
  type ShellCompletion,
} from "./types"

const ALL_KINDS: ShellCompletion["kind"][] = [
  "command",
  "builtin",
  "path",
  "directory",
  "option",
  "argument",
]

describe("COMPLETION_KIND_PRIORITY", () => {
  it("scores every kind, so ranking can never fall through to undefined", () => {
    for (const kind of ALL_KINDS) {
      expect(typeof COMPLETION_KIND_PRIORITY[kind]).toBe("number")
    }
    expect(Object.keys(COMPLETION_KIND_PRIORITY).sort()).toEqual([...ALL_KINDS].sort())
  })

  it("gives every kind a DISTINCT weight, so the order is total", () => {
    const weights = Object.values(COMPLETION_KIND_PRIORITY)
    expect(new Set(weights).size).toBe(weights.length)
  })

  it("ranks what a shell knows above what the filesystem merely matches", () => {
    // The rule the whole ranking exists to express: a builtin or a real command
    // beats a file whose name happens to start the same way.
    for (const semantic of ["builtin", "command", "option", "argument"] as const) {
      for (const filesystem of ["directory", "path"] as const) {
        expect(COMPLETION_KIND_PRIORITY[semantic]).toBeGreaterThan(
          COMPLETION_KIND_PRIORITY[filesystem]
        )
      }
    }
  })

  it("puts builtins above PATH executables, as a real shell resolves them", () => {
    expect(COMPLETION_KIND_PRIORITY.builtin).toBeGreaterThan(COMPLETION_KIND_PRIORITY.command)
  })

  it("puts a directory above a plain file — you keep typing into a directory", () => {
    expect(COMPLETION_KIND_PRIORITY.directory).toBeGreaterThan(COMPLETION_KIND_PRIORITY.path)
  })
})

describe("timing and size constants", () => {
  it("debounces fast enough to feel immediate while still collapsing a burst", () => {
    expect(COMPLETION_DEBOUNCE_MS).toBeGreaterThan(0)
    expect(COMPLETION_DEBOUNCE_MS).toBeLessThanOrEqual(150)
  })

  it("waits longer before judging a command than before completing it", () => {
    // Otherwise a word would be called unknown before the list that would have
    // completed it has even been requested.
    expect(DIAGNOSTIC_IDLE_MS).toBeGreaterThan(COMPLETION_DEBOUNCE_MS)
  })

  it("never judges a single character", () => {
    expect(DIAGNOSTIC_MIN_LENGTH).toBeGreaterThanOrEqual(2)
  })

  it("caps the list at a size a person can actually scan", () => {
    expect(MAX_COMPLETIONS).toBeGreaterThan(0)
    expect(MAX_COMPLETIONS).toBeLessThanOrEqual(100)
  })
})
