/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { MemoryDangerZone, clearQueryFor } from "./danger-zone"

const mockManageMemory = jest.fn()
jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: (...args: unknown[]) => mockManageMemory(...args),
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  MotionCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))

describe("clearQueryFor", () => {
  it("maps every destructive scope to the database query contract", () => {
    expect(clearQueryFor("all")).toBeUndefined()
    expect(clearQueryFor("invalidated")).toEqual({ status: "invalidated" })
    expect(clearQueryFor("global")).toEqual({ scope: "global" })
    expect(clearQueryFor("workspace")).toEqual({ scope: "workspace" })
    expect(clearQueryFor("character")).toEqual({ scope: "character" })
  })
})

describe("MemoryDangerZone", () => {
  beforeEach(() => {
    mockManageMemory.mockReset()
    mockManageMemory.mockResolvedValue({ ok: true, clearedCount: 4 })
  })

  it("stays collapsed until the user expands it", () => {
    render(<MemoryDangerZone />)
    const toggle = screen.getByRole("button", { name: /danger zone/i })

    expect(toggle).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: /back up first/i })).toHaveAttribute(
      "href",
      "/settings?section=data"
    )
  })

  it("requires confirmation before clearing all memories", async () => {
    render(<MemoryDangerZone defaultOpen />)
    fireEvent.click(screen.getByRole("button", { name: /clear memories/i }))
    fireEvent.click(await screen.findByRole("button", { name: /^clear memories$/i }))

    await waitFor(() =>
      expect(mockManageMemory).toHaveBeenCalledWith({ kind: "clear", query: undefined })
    )
  })
})
