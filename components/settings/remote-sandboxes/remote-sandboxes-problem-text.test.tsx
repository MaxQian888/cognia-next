import { render, screen } from "@testing-library/react"

import en from "@/i18n/messages/en/settings/remoteSandboxes.json"
import {
  RemoteSandboxesProblemText,
  remoteSandboxesProblemKey,
} from "./remote-sandboxes-problem-text"

describe("RemoteSandboxesProblemText", () => {
  it("has a sentence for every code it claims to know", () => {
    for (const code of Object.keys(en.errors).filter((key) => key !== "unknown")) {
      expect(remoteSandboxesProblemKey(code)).toBe(code)
    }
  })

  it("says the Host's refusal with its detail", () => {
    render(
      <RemoteSandboxesProblemText
        problem={{ code: "remote_sandboxes_invalid", message: "e2b: domain is not a DNS name" }}
      />
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The settings were refused: e2b: domain is not a DNS name"
    )
  })

  it("still shows the message for a code this build does not know", () => {
    render(<RemoteSandboxesProblemText problem={{ code: "from_the_future", message: "detail" }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong: detail")
    expect(screen.getByRole("alert")).toHaveAttribute("data-code", "from_the_future")
  })

  it("falls back to the code when the Host sent no message", () => {
    render(<RemoteSandboxesProblemText problem={{ code: "from_the_future", message: "" }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong: from_the_future")
  })
})
