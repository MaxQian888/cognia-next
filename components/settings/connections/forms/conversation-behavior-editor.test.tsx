import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConversationBehaviorEditor } from "./conversation-behavior-editor"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

describe("ConversationBehaviorEditor", () => {
  it("shows inheritance and effective sources for conversation scope", () => {
    render(
      <ConversationBehaviorEditor
        scope="conversation"
        value={{}}
        onChange={jest.fn()}
        sources={{ mode: "adapter-default" }}
      />
    )
    expect(screen.getByTestId("behavior-source-mode")).toHaveTextContent("effectiveSource")
    expect(screen.getByTestId("behavior-mode")).toHaveTextContent("inherit")
  })

  it("emits one shared draft shape", async () => {
    const onChange = jest.fn()
    render(
      <ConversationBehaviorEditor
        scope="adapter"
        value={{ mode: "auto", activationTtlHours: "" }}
        onChange={onChange}
      />
    )
    await userEvent.type(screen.getByTestId("behavior-ttl"), "12")
    expect(onChange).toHaveBeenLastCalledWith({ mode: "auto", activationTtlHours: "2" })
  })
})
