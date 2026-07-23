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
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalDatasetVersions: () => versions,
}))
const tagVersion = jest.fn(async () => {})
jest.mock("@/lib/db/eval-dataset-versions", () => ({
  tagVersion: (...a: unknown[]) => tagVersion(...(a as [])),
}))

import { VersionHistory } from "./version-history"

beforeEach(() => {
  versions = []
  tagVersion.mockClear()
})

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
})
