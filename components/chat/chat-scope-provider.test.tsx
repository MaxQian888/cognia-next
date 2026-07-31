import { render, screen } from "@testing-library/react"
import { ChatScopeProvider, useChatScope } from "./chat-scope-provider"

function Probe() {
  return <span>{useChatScope().sessionId}</span>
}

describe("ChatScopeProvider", () => {
  it("nests explicit session scopes without touching the global active session", () => {
    render(
      <ChatScopeProvider sessionId="resource:one">
        <Probe />
        <ChatScopeProvider sessionId="resource:two">
          <Probe />
        </ChatScopeProvider>
      </ChatScopeProvider>
    )
    expect(screen.getByText("resource:one")).toBeInTheDocument()
    expect(screen.getByText("resource:two")).toBeInTheDocument()
  })
})
