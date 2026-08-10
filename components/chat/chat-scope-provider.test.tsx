import { render, screen } from "@testing-library/react"
import { ChatScopeProvider, useChatScope } from "./chat-scope-provider"

function Probe() {
  const scope = useChatScope()
  return (
    <button type="button" onClick={() => void scope.compact?.()}>
      {scope.sessionId}
    </button>
  )
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

  it("keeps runtime controls scoped to the owning pane", () => {
    const outerCompact = jest.fn(async () => undefined)
    const innerCompact = jest.fn(async () => undefined)
    render(
      <ChatScopeProvider sessionId="outer" compact={outerCompact}>
        <Probe />
        <ChatScopeProvider sessionId="inner" compact={innerCompact}>
          <Probe />
        </ChatScopeProvider>
      </ChatScopeProvider>
    )

    screen.getByRole("button", { name: "inner" }).click()
    expect(innerCompact).toHaveBeenCalledTimes(1)
    expect(outerCompact).not.toHaveBeenCalled()
  })
})
