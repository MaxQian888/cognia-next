/** @jest-environment jsdom */
import { onTemplateRerunRequest, requestTemplateRerun } from "./rerun-request"
import type { ChatTemplateRun } from "./run"

const run: ChatTemplateRun = {
  templateId: "tpl",
  version: "1",
  text: "review {{module}}",
  params: { module: { kind: "text", value: "auth" } },
}

describe("template rerun request", () => {
  it("delivers the run to a subscriber and unsubscribes cleanly", () => {
    const handler = jest.fn()
    const off = onTemplateRerunRequest(handler)

    requestTemplateRerun({ sessionId: "ses_1", run })
    expect(handler).toHaveBeenCalledWith({ sessionId: "ses_1", run })

    off()
    requestTemplateRerun({ sessionId: "ses_1", run })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // Several composers are mounted at once in a split pane group; the address is
  // what stops a message from one conversation filling in all of them.
  it("carries the session it is addressed to", () => {
    const handler = jest.fn()
    const off = onTemplateRerunRequest(handler)
    requestTemplateRerun({ sessionId: "ses_2", run })
    expect(handler.mock.calls[0][0].sessionId).toBe("ses_2")
    off()
  })

  it("ignores an event with no usable payload", () => {
    const handler = jest.fn()
    const off = onTemplateRerunRequest(handler)
    window.dispatchEvent(new CustomEvent("cognia:chat-template:rerun", { detail: null }))
    window.dispatchEvent(new CustomEvent("cognia:chat-template:rerun", { detail: { run } }))
    expect(handler).not.toHaveBeenCalled()
    off()
  })
})
