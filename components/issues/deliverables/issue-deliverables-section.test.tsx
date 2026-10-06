/**
 * @jest-environment jsdom
 */

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { id: string; content?: string } }) => (
    <div data-testid={`preview-${artifact.id}`}>{artifact.content}</div>
  ),
}))
const mockArtifacts: Record<string, { id: string }> = { a2: { id: "a2" } }
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: (select: (state: { artifacts: typeof mockArtifacts }) => unknown) =>
    select({ artifacts: mockArtifacts }),
}))

const mockAcceptDelivery = jest.fn()
jest.mock("@/lib/db/issue-runs", () => ({
  acceptIssueDeliverable: (...args: unknown[]) => mockAcceptDelivery(...args),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { IssueRun, IssueRunArtifact } from "@/types/issues"
import { IssueDeliverablesSection } from "./issue-deliverables-section"
import { createDeliveryReceipt } from "@/lib/issues/deliverables"

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

it("previews the preserved copy and confirms exactly that version; failure remains retryable", async () => {
  const snapshot = {
    id: "a2",
    sessionId: "s",
    messageId: "m",
    type: "code" as const,
    title: "Report",
    content: "old preserved bytes",
    version: 1,
  }
  const first = {
    ...artifact("a2", 10),
    delivery: createDeliveryReceipt("artifact:a2", { snapshot }),
  }
  const second = {
    ...artifact("a2", 20),
    delivery: createDeliveryReceipt("artifact:a2", {
      snapshot: { ...snapshot, content: "new bytes", version: 2 },
    }),
  }
  mockAcceptDelivery.mockRejectedValueOnce(new Error("stale")).mockResolvedValue(123)
  render(<IssueDeliverablesSection runs={[run("r", 1, [first, second])]} />)
  fireEvent.click(screen.getByTestId("issue-deliverable-version-1"))
  expect(screen.getByText("old preserved bytes")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "deliverables.accept" }))
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("deliverables.acceptFailed")
  )
  fireEvent.click(screen.getByRole("button", { name: "deliverables.accept" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("deliverables.accepted"))
  expect(mockAcceptDelivery).toHaveBeenLastCalledWith("r", first.delivery.id, first.delivery.digest)
  fireEvent.click(screen.getByTestId("issue-deliverable-version-2"))
  expect(screen.getByText("new bytes")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "deliverables.accept" })).toBeInTheDocument()
})
