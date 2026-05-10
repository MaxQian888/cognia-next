/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import type { WorkflowRow } from "@/types/workflow/visual"

import { PinnedSection } from "./pinned-section"

jest.mock("next/link", () => {
  const Link = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
  return { __esModule: true, default: Link }
})

const liveQueryRef = { value: [] as Array<{ workflowId: string }> }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveQueryRef.value,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: {
      where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }),
    },
  }),
}))

jest.mock("./trigger-button", () => ({
  TriggerButton: ({ workflowId }: { workflowId: string }) => (
    <button type="button" data-testid={`trigger-${workflowId}`}>
      Run
    </button>
  ),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = { pinned: "Pinned", activeBadge: "Active" }
    return map[key] ?? key
  },
}))

const wf = (id: string, name = id): WorkflowRow =>
  ({
    id,
    name,
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: {},
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as WorkflowRow

beforeEach(() => {
  liveQueryRef.value = []
})

describe("<PinnedSection />", () => {
  it("renders nothing when pinnedIds is empty", () => {
    const { container } = render(<PinnedSection workflows={[wf("a")]} pinnedIds={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders only the workflows that are pinned", () => {
    render(
      <PinnedSection
        workflows={[wf("a", "Alpha"), wf("b", "Beta"), wf("c", "Gamma")]}
        pinnedIds={["a", "c"]}
      />
    )
    expect(screen.getByTestId("pinned-card-a")).toBeInTheDocument()
    expect(screen.queryByTestId("pinned-card-b")).not.toBeInTheDocument()
    expect(screen.getByTestId("pinned-card-c")).toBeInTheDocument()
  })

  it("shows the Active badge when a pinned workflow has a running run", () => {
    liveQueryRef.value = [{ workflowId: "a" }]
    render(<PinnedSection workflows={[wf("a")]} pinnedIds={["a"]} />)
    expect(screen.getByTestId("pinned-active-a")).toBeInTheDocument()
  })
})
