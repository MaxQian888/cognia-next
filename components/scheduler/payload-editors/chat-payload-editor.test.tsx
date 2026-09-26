import { render, screen } from "@testing-library/react"

import { ChatPayloadEditor } from "./chat-payload-editor"
import { EMPTY_CHAT_LIKE_DRAFT } from "./types"

describe("ChatPayloadEditor", () => {
  it("renders the default chat editor without an unstable store snapshot loop", () => {
    render(
      <ChatPayloadEditor
        taskType="chat"
        draft={{ ...EMPTY_CHAT_LIKE_DRAFT }}
        onDraftChange={jest.fn()}
        charactersForTesting={[]}
        skillsForTesting={[]}
        teamsForTesting={[]}
      />
    )

    expect(screen.getByTestId("chat-payload-editor")).toBeInTheDocument()
    expect(screen.getByTestId("chat-payload-editor-prompt-input")).toBeInTheDocument()
    expect(screen.getByTestId("chat-payload-editor-session-title-input")).toHaveAttribute(
      "placeholder",
      'Defaults to "Task Name (scheduled)"'
    )
  })

  it("says the permission mode and denied tools can only narrow the agent", () => {
    render(
      <ChatPayloadEditor
        taskType="agent"
        draft={{ ...EMPTY_CHAT_LIKE_DRAFT, disallowedTools: ["Bash"] }}
        onDraftChange={jest.fn()}
        charactersForTesting={[]}
        skillsForTesting={[]}
        teamsForTesting={[]}
      />
    )

    expect(
      screen.getByText(
        "A cap for this run: it can lower the agent's permission mode, never raise it."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Added to the agent's own disallowed tools. It never re-allows a tool the agent, a tool filter or Restricted Mode already blocks."
      )
    ).toBeInTheDocument()
  })
})
