/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

const isTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

/** What the live query currently reports; `undefined` is "still loading". */
let liveRows: unknown[] | undefined = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveRows }))

const db = {
  listRecordingsForSkill: jest.fn(async () => []),
  duplicateRecording: jest.fn(async () => null),
  deleteRecording: jest.fn(async () => undefined),
}
jest.mock("@/lib/db/skill-recordings", () => ({
  listRecordingsForSkill: (...a: unknown[]) => db.listRecordingsForSkill(...(a as [])),
  duplicateRecording: (...a: unknown[]) => db.duplicateRecording(...(a as [])),
  deleteRecording: (...a: unknown[]) => db.deleteRecording(...(a as [])),
}))

const recordListRecoverable = jest.fn(async () => [])
jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordListRecoverable: () => recordListRecoverable(),
}))

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m) },
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SkillRecordingRow } from "@/lib/db/skill-recordings"

import { SkillRecordingsSection } from "./skill-recordings-section"

const BUNDLE = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

function row(patch: Partial<SkillRecordingRow> = {}): SkillRecordingRow {
  return {
    id: BUNDLE,
    skillId: "skill-1",
    status: "saved",
    bundleId: BUNDLE,
    edits: { bySeq: {}, manual: [] },
    inputVariables: [],
    selectedAssetIds: [],
    stepCount: 4,
    includedCount: 4,
    bundleBytes: 1024,
    versionNumber: 1,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauri.mockReturnValue(true)
  liveRows = []
  // `clearAllMocks` clears calls but keeps implementations, so the defaults
  // have to be restated or one test's fork leaks into the next one.
  recordListRecoverable.mockResolvedValue([])
  db.duplicateRecording.mockResolvedValue(null)
  db.deleteRecording.mockResolvedValue(undefined)
})

describe("SkillRecordingsSection", () => {
  it("shows a placeholder until the query answers", () => {
    liveRows = undefined
    render(<SkillRecordingsSection skillId="skill-1" />)
    expect(screen.getByLabelText("title")).toBeInTheDocument()
  })

  it("says a hand-written skill has no source capture", () => {
    render(<SkillRecordingsSection skillId="skill-1" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists every version in the order the query returns them", () => {
    liveRows = [row({ id: "b", versionNumber: 2 }), row({ id: "a", versionNumber: 1 })]
    render(<SkillRecordingsSection skillId="skill-1" />)

    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('versionLabel:{"n":2}')
  })

  it("says saved versions are read-only", () => {
    liveRows = [row()]
    render(<SkillRecordingsSection skillId="skill-1" />)
    expect(screen.getByText("immutable")).toBeInTheDocument()
  })

  it("marks a row whose native bundle is gone", async () => {
    liveRows = [row()]
    render(<SkillRecordingsSection skillId="skill-1" />)
    expect(await screen.findByText("bundleMissing")).toBeInTheDocument()
  })

  it("treats a bundle the native side reports as present", async () => {
    liveRows = [row()]
    recordListRecoverable.mockResolvedValue([{ recordingId: BUNDLE }] as never)
    render(<SkillRecordingsSection skillId="skill-1" />)
    await waitFor(() => expect(recordListRecoverable).toHaveBeenCalled())
    expect(screen.queryByText("bundleMissing")).not.toBeInTheDocument()
  })

  it("does not claim a bundle is missing when it could not ask", () => {
    // A false alarm on every row would be worse than not checking.
    isTauri.mockReturnValue(false)
    liveRows = [row()]
    render(<SkillRecordingsSection skillId="skill-1" />)
    expect(screen.queryByText("bundleMissing")).not.toBeInTheDocument()
    expect(recordListRecoverable).not.toHaveBeenCalled()
  })

  it("does not claim a bundle is missing when the native call fails", async () => {
    liveRows = [row()]
    recordListRecoverable.mockRejectedValue(new Error("ipc down"))
    render(<SkillRecordingsSection skillId="skill-1" />)
    await waitFor(() => expect(recordListRecoverable).toHaveBeenCalled())
    expect(screen.queryByText("bundleMissing")).not.toBeInTheDocument()
  })

  it("forks a version — the live query brings the new one in", async () => {
    liveRows = [row()]
    recordListRecoverable.mockResolvedValue([{ recordingId: BUNDLE }] as never)
    db.duplicateRecording.mockResolvedValue(row({ id: "fork", versionNumber: 2 }) as never)
    render(<SkillRecordingsSection skillId="skill-1" />)

    await userEvent.click(screen.getByRole("button", { name: /duplicate/ }))
    expect(db.duplicateRecording).toHaveBeenCalledWith(BUNDLE)
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('duplicated:{"n":2}'))
  })

  it("reports a fork that could not be made", async () => {
    liveRows = [row()]
    recordListRecoverable.mockResolvedValue([{ recordingId: BUNDLE }] as never)
    render(<SkillRecordingsSection skillId="skill-1" />)

    await userEvent.click(screen.getByRole("button", { name: /duplicate/ }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("duplicateFailed"))
  })

  it("deletes a row without touching the capture behind it", async () => {
    // Destroying the only copy of a recording is a decision of its own, and it
    // lives on the skill-deletion dialog.
    liveRows = [row()]
    render(<SkillRecordingsSection skillId="skill-1" />)

    await userEvent.click(screen.getByRole("button", { name: /delete/ }))
    expect(db.deleteRecording).toHaveBeenCalledWith(BUNDLE)
  })
})
