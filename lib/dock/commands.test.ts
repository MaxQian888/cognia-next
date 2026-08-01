import {
  DOCK_COMMAND_IDS,
  isDockCommandId,
  registerDockCommands,
  resolveDockCommandHandlers,
} from "./commands"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { APP_SHORTCUT_CATALOG } from "@/lib/shortcuts/app-catalog"

describe("dock command catalog", () => {
  it("has a shortcut descriptor for every command", () => {
    // A command with no descriptor cannot be rebound, and a descriptor with no
    // command is a settings row that does nothing. The two lists have to agree.
    const descriptorIds = new Set(APP_SHORTCUT_CATALOG.map((d) => d.id))
    for (const id of DOCK_COMMAND_IDS) {
      expect(descriptorIds.has(id)).toBe(true)
    }
  })

  it("ships only undo and redo bound", () => {
    // Every other action is reachable from the tab menu and the palette;
    // burning five more chords for pointer-driven actions is not a trade worth
    // making.
    const bound = APP_SHORTCUT_CATALOG.filter(
      (d) => d.category === "app.dock" && d.defaultChord !== ""
    ).map((d) => d.id)
    expect(bound.sort()).toEqual(["dock.layout.redo", "dock.layout.undo"])
  })

  it("uses the documented default chords", () => {
    const chordOf = (id: string) => APP_SHORTCUT_CATALOG.find((d) => d.id === id)?.defaultChord
    expect(chordOf("dock.layout.undo")).toBe("ctrl+alt+z")
    expect(chordOf("dock.layout.redo")).toBe("ctrl+alt+shift+z")
  })

  it("does not collide with a chord another feature already owns", () => {
    const dockChords = new Set(
      APP_SHORTCUT_CATALOG.filter((d) => d.category === "app.dock" && d.defaultChord).map(
        (d) => d.defaultChord
      )
    )
    const others = APP_SHORTCUT_CATALOG.filter((d) => d.category !== "app.dock" && d.defaultChord)
    for (const descriptor of others) {
      expect(dockChords.has(descriptor.defaultChord)).toBe(false)
    }
  })

  it("recognises only its own ids", () => {
    expect(isDockCommandId("dock.layout.undo")).toBe(true)
    expect(isDockCommandId("dock.layout.explode")).toBe(false)
    expect(isDockCommandId("artifacts.toggleDock")).toBe(false)
  })
})

describe("resolveDockCommandHandlers", () => {
  it("registers nothing for an action the host cannot serve", () => {
    // Better a missing palette entry than one that silently does nothing.
    expect(resolveDockCommandHandlers({})).toEqual([])
  })

  it("maps each supplied action to its command", () => {
    const undo = jest.fn()
    const reset = jest.fn()
    const handlers = resolveDockCommandHandlers({ undo, reset })
    expect(handlers.map((h) => h.id).sort()).toEqual(["dock.layout.reset", "dock.layout.undo"])
    handlers.find((h) => h.id === "dock.layout.undo")!.handler()
    expect(undo).toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
  })

  it("fans one split action out to all four directions", () => {
    const splitActive = jest.fn()
    const handlers = resolveDockCommandHandlers({ splitActive })
    expect(handlers.map((h) => h.id).sort()).toEqual([
      "dock.split.down",
      "dock.split.left",
      "dock.split.right",
      "dock.split.up",
    ])
    for (const handler of handlers) handler.handler()
    expect(splitActive.mock.calls.map((c) => c[0]).sort()).toEqual(["down", "left", "right", "up"])
  })

  it("covers every id in the closed set when the host serves everything", () => {
    const handlers = resolveDockCommandHandlers({
      undo: jest.fn(),
      redo: jest.fn(),
      reset: jest.fn(),
      closeActive: jest.fn(),
      floatActive: jest.fn(),
      popoutActive: jest.fn(),
      redockActive: jest.fn(),
      splitActive: jest.fn(),
    })
    expect(handlers.map((h) => h.id).sort()).toEqual([...DOCK_COMMAND_IDS].sort())
  })
})

describe("registerDockCommands", () => {
  it("makes each command executable and cleans up exactly what it added", async () => {
    const undo = jest.fn()
    const dispose = registerDockCommands({ undo })
    expect(getCommand("dock.layout.undo")).toBeDefined()

    await executeCommand("dock.layout.undo")
    expect(undo).toHaveBeenCalled()

    dispose()
    expect(getCommand("dock.layout.undo")).toBeUndefined()
  })

  it("leaves commands it never registered alone", () => {
    const first = registerDockCommands({ undo: jest.fn() })
    const second = registerDockCommands({ reset: jest.fn() })
    second()
    // A host unmounting must not strip another host's commands.
    expect(getCommand("dock.layout.undo")).toBeDefined()
    expect(getCommand("dock.layout.reset")).toBeUndefined()
    first()
  })
})
