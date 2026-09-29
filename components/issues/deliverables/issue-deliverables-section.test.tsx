/**
 * @jest-environment jsdom
 */

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { id: string } }) => (
    <div data-testid={`preview-${artifact.id}`} />
  ),
}))
const mockArtifacts: Record<string, { id: string }> = { a2: { id: "a2" } }
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: (select: (state: { artifacts: typeof mockArtifacts }) => unknown) =>
    select({ artifacts: mockArtifacts }),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import type { IssueRun, IssueRunArtifact } from "@/types/issues"
import { IssueDeliverablesSection } from "./issue-deliverables-section"

const run = (id: string, startedAt: number, artifacts: IssueRunArtifact[]): IssueRun => ({
  id,
  issueId: "i1",
  projectId: "w1",
  adapterId: "agent-task",
  kind: "agent-task",
  targetId: "t",
  status: "succeeded",
  by: { kind: "human" },
  startedAt,
  updatedAt: startedAt,
  artifacts,
})

const artifact = (id: string, linkedAt: number): IssueRunArtifact => ({
  label: "report.csv",
  href: `artifact:${id}`,
  artifactId: id,
  sessionId: "s1",
  deliverable: true,
  linkedAt,
})

it("renders nothing until a run handed something over", () => {
  const { container } = render(
    <IssueDeliverablesSection runs={[run("r1", 1, [{ label: "Session", href: "/?session=s" }])]} />
  )
  expect(container).toBeEmptyDOMElement()
})

it("shows the newest version with a preview, and switches to an older one", () => {
  render(
    <IssueDeliverablesSection
      runs={[run("r2", 20, [artifact("a2", 25)]), run("r1", 10, [artifact("a1", 15)])]}
    />
  )
  expect(screen.getByTestId("preview-a2")).toBeInTheDocument()
  expect(screen.getByTestId("issue-deliverable-version-2")).toHaveAttribute("aria-pressed", "true")
  fireEvent.click(screen.getByTestId("issue-deliverable-version-1"))
  // a1 is not on this device: say so instead of previewing.
  expect(screen.queryByTestId("preview-a2")).toBeNull()
  expect(screen.getByText("deliverables.previewUnavailable")).toBeInTheDocument()
})
