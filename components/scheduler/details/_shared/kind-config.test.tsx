/** @jest-environment jsdom */

import { render } from "@testing-library/react"
import { kindConfig } from "./kind-config"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

describe("kindConfig", () => {
  const allKinds: ScheduledItemKind[] = [
    "app",
    "workflow",
    "backup",
    "plugin",
    "system",
    "connector",
  ]

  it("provides an entry for every ScheduledItemKind including connector", () => {
    for (const kind of allKinds) {
      expect(kindConfig[kind]).toBeDefined()
      expect(kindConfig[kind].bg).toMatch(/^bg-/)
      expect(kindConfig[kind].color).toMatch(/^text-/)
      expect(kindConfig[kind].icon).toBeTruthy()
    }
  })

  it("uses distinct background colors per kind", () => {
    const bgs = allKinds.map((k) => kindConfig[k].bg)
    expect(new Set(bgs).size).toBe(bgs.length)
  })

  it("renders icons that mount cleanly in the DOM", () => {
    for (const kind of allKinds) {
      const { container, unmount } = render(<span>{kindConfig[kind].icon}</span>)
      // Each lucide icon renders an <svg> element
      expect(container.querySelector("svg")).toBeTruthy()
      unmount()
    }
  })
})
