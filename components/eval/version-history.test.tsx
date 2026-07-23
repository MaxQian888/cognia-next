/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { EvalDatasetVersion } from "@/types/eval/version"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

let versions: EvalDatasetVersion[] = []
let cases: { id: string; input: string }[] = []
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalDatasetVersions: () => versions,
  useEvalCases: () => cases,
}))
const tagVersion = jest.fn(async () => {})
const restoreVersion = jest.fn(async () => ({ deleted: 0, readded: 0 }))
jest.mock("@/lib/db/eval-dataset-versions", () => ({
  tagVersion: (...a: unknown[]) => tagVersion(...(a as [])),
  restoreVersion: (...a: unknown[]) => restoreVersion(...(a as unknown as [string])),
}))

import { VersionHistory } from "./version-history"

beforeEach(() => {
  versions = []
  cases = []
  tagVersion.mockClear()
  restoreVersion.mockClear().mockResolvedValue({ deleted: 0, readded: 0 })
})

const version = (id: string, num: number, caseIds: string[]): EvalDatasetVersion =>
  ({
    id,
    datasetId: "d",
    version: num,
    caseIds,
    casesHash: `hash-${id}`,
    createdAt: num,
  }) as EvalDatasetVersion

describe("VersionHistory", () => {
  it("renders the empty state", () => {
    render(<VersionHistory datasetId="d" />)
    expect(screen.getByText("versions.empty")).toBeInTheDocument()
  })

  it("lists versions and tags one", async () => {
    versions = [
      { id: "v1", datasetId: "d", version: 2, caseIds: [], casesHash: "abcd1234ef", createdAt: 0 },
    ]
    render(<VersionHistory datasetId="d" />)
    expect(screen.getByText("abcd1234")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("versions.tag"))
    fireEvent.change(screen.getByLabelText("versions.tagPlaceholder"), {
      target: { value: "prod" },
    })
    fireEvent.click(screen.getByText("versions.applyTag"))
    await waitFor(() => expect(tagVersion).toHaveBeenCalledWith("v1", "prod"))
  })

  it("counts cases from the snapshot's ids", () => {
    versions = [
      {
        id: "v9",
        datasetId: "d",
        version: 3,
        caseIds: ["c1", "c2", "c3"],
        casesHash: "hash",
        createdAt: 0,
      } as EvalDatasetVersion,
    ]
    render(<VersionHistory datasetId="d" />)
    expect(screen.getByText('versions.cases:{"count":3}')).toBeInTheDocument()
  })

  it("still counts a legacy snapshot that stored full copies", () => {
    // Snapshots used to duplicate every case's text; those rows must stay
    // readable rather than reporting zero.
    versions = [
      {
        id: "v-legacy",
        datasetId: "d",
        version: 1,
        cases: [{ id: "c1" }, { id: "c2" }],
        casesHash: "hash",
        createdAt: 0,
      } as unknown as EvalDatasetVersion,
    ]
    render(<VersionHistory datasetId="d" />)
    expect(screen.getByText('versions.cases:{"count":2}')).toBeInTheDocument()
  })

  it("diffs a compared snapshot against the others", () => {
    // Snapshots were write-only — "run A 80%, run B 60%" is unactionable
    // without knowing which cases moved underneath the two runs.
    versions = [version("v2", 2, ["a", "c"]), version("v1", 1, ["a", "b"])]
    cases = [
      { id: "a", input: "one" },
      { id: "c", input: "three" },
    ]
    render(<VersionHistory datasetId="d" />)
    fireEvent.click(screen.getAllByLabelText("versions.compare")[1]) // pick v1 as the baseline
    const diff = screen.getByTestId("version-diff")
    // v1 → v2: dropped b, added c, kept a.
    expect(diff).toHaveTextContent('{"added":1,"removed":1,"changed":0,"unchanged":1}')
  })

  it("toggles the compare baseline off again", () => {
    versions = [version("v2", 2, ["a"]), version("v1", 1, ["a"])]
    cases = [{ id: "a", input: "one" }]
    render(<VersionHistory datasetId="d" />)
    const compareV1 = screen.getAllByLabelText("versions.compare")[1]
    fireEvent.click(compareV1)
    expect(screen.getByTestId("version-diff")).toBeInTheDocument()
    fireEvent.click(compareV1) // same button again clears the baseline
    expect(screen.queryByTestId("version-diff")).not.toBeInTheDocument()

    // …and the footer's explicit close button clears it too.
    fireEvent.click(compareV1)
    fireEvent.click(screen.getByText("versions.closeDiff"))
    expect(screen.queryByTestId("version-diff")).not.toBeInTheDocument()
  })

  it("says the snapshots are identical when nothing moved", () => {
    versions = [version("v2", 2, ["a", "b"]), version("v1", 1, ["a", "b"])]
    cases = [
      { id: "a", input: "one" },
      { id: "b", input: "two" },
    ]
    render(<VersionHistory datasetId="d" />)
    fireEvent.click(screen.getAllByLabelText("versions.compare")[1])
    expect(screen.getByTestId("version-diff")).toHaveTextContent("versions.diffNone")
  })

  it("confirms before a destructive restore, then runs it", async () => {
    versions = [version("v1", 1, ["a"])]
    cases = [
      { id: "a", input: "one" },
      { id: "b", input: "two" },
    ]
    render(<VersionHistory datasetId="d" />)
    fireEvent.click(screen.getByLabelText("versions.restore"))
    // First click only warns — restoring deletes the case added since.
    expect(screen.getByTestId("restore-confirm")).toHaveTextContent('{"deleted":1}')
    expect(restoreVersion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText("versions.restore"))
    await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith("v1"))
  })

  it("warns that an id-only snapshot cannot resurrect deleted cases", () => {
    // v1 pinned {a,b}; b was later deleted. Its ids-only snapshot kept no copy.
    versions = [version("v1", 1, ["a", "b"])]
    cases = [{ id: "a", input: "one" }]
    render(<VersionHistory datasetId="d" />)
    fireEvent.click(screen.getByLabelText("versions.restore"))
    expect(screen.getByTestId("restore-confirm")).toHaveTextContent("restoreMissing")
  })

  it("reports the outcome of a restore", async () => {
    restoreVersion.mockResolvedValue({ deleted: 2, readded: 1 })
    versions = [version("v1", 1, ["a"])]
    cases = [{ id: "a", input: "one" }]
    render(<VersionHistory datasetId="d" />)
    fireEvent.click(screen.getByLabelText("versions.restore"))
    fireEvent.click(screen.getByLabelText("versions.restore"))
    expect(await screen.findByRole("status")).toHaveTextContent('{"deleted":2,"readded":1}')
  })
})
