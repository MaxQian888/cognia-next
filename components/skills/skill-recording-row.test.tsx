/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  // Namespaced, because this row reads from two namespaces and the test needs
  // to tell `versions.*` from `interrupt.*` apart.
  useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${ns}.${key}:${JSON.stringify(vars)}` : `${ns}.${key}`,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SkillRecordingRow as RecordingRow } from "@/lib/db/skill-recordings"

import { formatBundleSize, SkillRecordingRow } from "./skill-recording-row"

const V = "skills.recorder.versions"
const I = "skills.recorder.interrupt"

function recording(patch: Partial<RecordingRow> = {}): RecordingRow {
  return {
    id: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
    skillId: "skill-1",
    status: "saved",
    bundleId: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
    edits: { bySeq: {}, manual: [] },
    inputVariables: [],
    selectedAssetIds: [],
    stepCount: 12,
    includedCount: 9,
    bundleBytes: 2048,
    versionNumber: 3,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

function renderRow(row = recording(), bundlePresent = true) {
  const onDuplicate = jest.fn()
  const onDelete = jest.fn()
  render(
    <SkillRecordingRow
      recording={row}
      bundlePresent={bundlePresent}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
    />
  )
  return { onDuplicate, onDelete }
}

describe("formatBundleSize", () => {
  it("rounds to a unit a person can read", () => {
    expect(formatBundleSize(512)).toBe("512 B")
    expect(formatBundleSize(2048)).toBe("2 KB")
    expect(formatBundleSize(5 * 1024 * 1024)).toBe("5.0 MB")
  })

  it("handles an empty bundle", () => {
    expect(formatBundleSize(0)).toBe("0 B")
  })
})

describe("SkillRecordingRow", () => {
  it("names the version and its state", () => {
    renderRow()
    expect(screen.getByText(`${V}.versionLabel:{"n":3}`)).toBeInTheDocument()
    expect(screen.getByText(`${V}.status.saved`)).toBeInTheDocument()
  })

  it("reports what survived review, not just how much was captured", () => {
    renderRow()
    expect(screen.getByText(`${V}.stepCounts:{"included":9,"total":12}`)).toBeInTheDocument()
  })

  it("names the model that wrote the draft", () => {
    renderRow(
      recording({
        generation: {
          provider: "anthropic",
          model: "claude",
          locale: "en",
          redacted: false,
          generatedAt: 1,
          promptHash: "h",
        },
      })
    )
    expect(screen.getByText(/anthropic · claude/)).toBeInTheDocument()
  })

  it("says a template wrote it rather than naming a model that never saw it", () => {
    renderRow()
    expect(screen.getByText(`${V}.manual`)).toBeInTheDocument()
  })

  it("says when redaction altered the transcript before it was sent", () => {
    renderRow(
      recording({
        generation: {
          provider: "p",
          model: "m",
          locale: "en",
          redacted: true,
          generatedAt: 1,
          promptHash: "h",
        },
      })
    )
    expect(screen.getByText(`${V}.redacted`)).toBeInTheDocument()
  })

  it("stays quiet about redaction when nothing was altered", () => {
    renderRow()
    expect(screen.queryByText(`${V}.redacted`)).not.toBeInTheDocument()
  })

  it("explains an interrupted recording in the interrupt's own words", () => {
    renderRow(
      recording({
        status: "interrupted",
        interrupt: { reason: "killSwitch", from: "recording", at: 5 },
      })
    )
    expect(screen.getByText(`${I}.reason.killSwitch`)).toBeInTheDocument()
  })

  it("forks a version rather than editing it in place", async () => {
    // Saved versions are immutable; presenting this as an edit would promise
    // something the data model refuses.
    const row = recording()
    const { onDuplicate } = renderRow(row)
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`${V}\\.duplicate`) }))
    expect(onDuplicate).toHaveBeenCalledWith(row.id)
  })

  it("cannot fork a recording whose capture is gone, and says why", async () => {
    renderRow(recording(), false)
    expect(screen.getByText(`${V}.bundleMissing`)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: new RegExp(`${V}\\.duplicate`) })).toBeDisabled()
  })

  it("can still delete a row whose capture is gone — the provenance is stale", async () => {
    const row = recording()
    const { onDelete } = renderRow(row, false)
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`${V}\\.delete`) }))
    expect(onDelete).toHaveBeenCalledWith(row.id)
  })
})
