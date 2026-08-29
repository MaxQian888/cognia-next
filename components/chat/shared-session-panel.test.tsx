import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

const resolveContext = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: (...args: unknown[]) => resolveContext(...args),
}))

import { SharedSessionPanel } from "./shared-session-panel"

function session(collaboration?: ChatSession["collaboration"]): ChatSession {
  return {
    id: "local_1",
    projectId: "workspace_1",
    title: "Conversation",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
    collaboration,
  }
}

describe("SharedSessionPanel", () => {
  beforeEach(() => {
    resolveContext.mockReset().mockResolvedValue(null)
  })

  it("marks legacy and local sessions private by default", () => {
    render(<SharedSessionPanel session={session()} />)
    expect(screen.getByRole("button", { name: "openPrivateSession" })).toHaveTextContent("private")
  })

  it("marks a server-bound session shared and exposes a configured-state explanation", async () => {
    render(
      <SharedSessionPanel
        session={session({
          orgId: "org_1",
          workspaceId: "workspace_1",
          sessionId: "shared_1",
          policyRevision: 1,
          syncCursor: 0,
        })}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
    await waitFor(() => expect(screen.getByText("notConfigured")).toBeInTheDocument())
  })
})
