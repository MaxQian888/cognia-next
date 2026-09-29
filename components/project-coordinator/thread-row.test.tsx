/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("./thread-actions", () => ({
  ThreadActions: ({ state }: { state: string }) => <span data-testid="actions">{state}</span>,
}))

import { ProjectThreadRow } from "./thread-row"

describe("ProjectThreadRow", () => {
  it("links to the thread and shows its state and branch", () => {
    render(
      <ProjectThreadRow
        row={{
          thread: {
            id: "t1",
            title: "Fix login",
            createdAt: 1,
            updatedAt: 1,
            executionContext: { branch: "thread/fix-login" },
          } as ChatSession,
          status: "streaming",
          pendingApprovals: 0,
          state: "working",
        }}
      />
    )
    expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toContain("t1")
    expect(screen.getByText("thread/fix-login")).toBeInTheDocument()
    expect(screen.getByTestId("thread-state-working")).toBeInTheDocument()
    expect(screen.getByTestId("project-thread-run-t1-streaming")).toBeInTheDocument()
    expect(screen.getByTestId("actions").textContent).toBe("working")
  })

  it("names an untitled thread", () => {
    render(
      <ProjectThreadRow
        row={{
          thread: { id: "t2", title: " ", createdAt: 1, updatedAt: 1 } as ChatSession,
          status: "idle",
          pendingApprovals: 0,
          state: "idle",
        }}
      />
    )
    expect(screen.getByRole("link", { name: "Untitled thread" })).toBeInTheDocument()
  })
})
