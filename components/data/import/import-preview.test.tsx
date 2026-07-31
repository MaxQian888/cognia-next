/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import type { BackupPackageV3, BackupPayloadV3 } from "@/lib/data/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join("|")}` : key,
}))

import { ImportPreview, PayloadRowCounts } from "./import-preview"

function payload(over: Partial<BackupPayloadV3> = {}): BackupPayloadV3 {
  return over as BackupPayloadV3
}

function pkg(over: Partial<BackupPayloadV3> = {}): BackupPackageV3 {
  return {
    version: "3.0",
    manifest: {
      version: "3.0",
      backend: "tauri-dexie",
      appVersion: "0.1.0",
      exportedAt: "2026-06-01T00:00:00.000Z",
      schemaVersion: 3,
      integrity: { algorithm: "SHA-256", checksum: "abcdef0123456789deadbeef" },
      traceId: "trace-1234-5678",
    },
    payload: payload(over),
  }
}

describe("PayloadRowCounts", () => {
  it("counts array-valued tables", () => {
    render(<PayloadRowCounts payload={payload({ skills: [{ id: "a" }, { id: "b" }] as never })} />)
    expect(screen.getByText("skills:")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("counts a present non-array table as one", () => {
    render(<PayloadRowCounts payload={payload({ settings: { theme: "dark" } as never })} />)
    const row = screen.getByText("settings:").closest("li")!
    expect(within(row).getByText("1")).toBeInTheDocument()
  })

  it("renders absent tables as zero rather than omitting them", () => {
    render(<PayloadRowCounts payload={payload()} />)
    // Every known field still gets a row — a missing table reads as "0", which
    // is what makes this a blast-radius preview rather than a highlight reel.
    expect(screen.getByText("characters:")).toBeInTheDocument()
    expect(screen.getAllByText("0").length).toBeGreaterThan(5)
  })

  it("adds the localStorage snapshot row only when there are snapshots", () => {
    const { rerender } = render(<PayloadRowCounts payload={payload()} />)
    expect(screen.queryByText("localStorageSnapshots:")).not.toBeInTheDocument()

    rerender(
      <PayloadRowCounts payload={payload({ localStorageSnapshots: { theme: "x" } as never })} />
    )
    const row = screen.getByText("localStorageSnapshots:").closest("li")!
    expect(within(row).getByText("1")).toBeInTheDocument()
  })
})

describe("ImportPreview", () => {
  it("pairs the manifest header with the shared row counts", () => {
    render(<ImportPreview pkg={pkg({ skills: [{ id: "a" }] as never })} />)
    expect(screen.getByText("preview")).toBeInTheDocument()
    expect(screen.getByText(/backup\.previewBackend:/)).toBeInTheDocument()
    expect(screen.getByText("skills:")).toBeInTheDocument()
  })

  it("truncates the integrity checksum and trace id", () => {
    render(<ImportPreview pkg={pkg()} />)
    expect(screen.getByText(/abcdef012345…/)).toBeInTheDocument()
    expect(screen.getByText(/trace-12/)).toBeInTheDocument()
    expect(screen.queryByText(/trace-1234-5678/)).not.toBeInTheDocument()
  })
})
