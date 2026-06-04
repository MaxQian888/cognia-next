/**
 * @jest-environment jsdom
 *
 * Tests for the zone-filtered context-menu hook + the CustomEvent click
 * dispatcher (`firePluginContextMenuItem`) and disabled resolution.
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import {
  firePluginContextMenuItem,
  isContextMenuItemDisabled,
  usePluginContextMenuItems,
} from "./use-plugin-context-menu-items"
import {
  __resetContextMenuRegistryForTesting,
  registerContextMenuItem,
  type PluginContextMenuEntry,
} from "@/lib/plugin/context-menu/registry"
import type { ContextMenuClickContext, ContextMenuItem } from "@/types/plugin"

function makeEntry(overrides?: {
  id?: string
  item?: Partial<ContextMenuItem>
}): PluginContextMenuEntry {
  const id = overrides?.id ?? "p:demo"
  return {
    id,
    pluginId: "p",
    item: { id, label: "Demo", onClick: () => {}, ...overrides?.item },
  }
}

afterEach(() => {
  __resetContextMenuRegistryForTesting()
})

describe("usePluginContextMenuItems", () => {
  it("filters by zone and reacts to registry mutations", async () => {
    registerContextMenuItem(makeEntry({ id: "p:msg", item: { when: "chat:message" } }))
    const { result } = renderHook(() => usePluginContextMenuItems("chat:message"))
    expect(result.current.map((e) => e.id)).toEqual(["p:msg"])

    act(() => {
      registerContextMenuItem(makeEntry({ id: "p:late", item: { when: "chat:message" } }))
      registerContextMenuItem(makeEntry({ id: "p:canvas", item: { when: "canvas" } }))
    })

    await waitFor(() => {
      expect(result.current.map((e) => e.id)).toEqual(["p:msg", "p:late"])
    })
  })
})

describe("firePluginContextMenuItem", () => {
  const clickContext: ContextMenuClickContext = {
    target: "chat:message",
    messageId: "msg-1",
  }

  it("dispatches the plugin-context-menu CustomEvent so registered handlers fire", () => {
    const entry = makeEntry({ id: "p:fire" })
    const handler = jest.fn()
    window.addEventListener("plugin-context-menu:p:fire", ((e: CustomEvent) =>
      handler(e.detail)) as EventListener)

    firePluginContextMenuItem(entry, clickContext)

    expect(handler).toHaveBeenCalledWith(clickContext)
  })

  it("no-ops when the item is disabled for the context", () => {
    const entry = makeEntry({ id: "p:off", item: { disabled: true } })
    const handler = jest.fn()
    window.addEventListener("plugin-context-menu:p:off", handler)

    firePluginContextMenuItem(entry, clickContext)

    expect(handler).not.toHaveBeenCalled()
  })
})

describe("isContextMenuItemDisabled", () => {
  const clickContext: ContextMenuClickContext = { target: "canvas" }

  it("resolves boolean and functional disabled flags", () => {
    expect(isContextMenuItemDisabled(makeEntry(), clickContext)).toBe(false)
    expect(isContextMenuItemDisabled(makeEntry({ item: { disabled: true } }), clickContext)).toBe(
      true
    )
    expect(
      isContextMenuItemDisabled(
        makeEntry({ item: { disabled: (ctx) => ctx.target === "canvas" } }),
        clickContext
      )
    ).toBe(true)
  })

  it("treats a throwing disabled() as disabled", () => {
    expect(
      isContextMenuItemDisabled(
        makeEntry({
          item: {
            disabled: () => {
              throw new Error("boom")
            },
          },
        }),
        clickContext
      )
    ).toBe(true)
  })
})
