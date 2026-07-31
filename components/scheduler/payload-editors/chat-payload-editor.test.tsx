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
})
