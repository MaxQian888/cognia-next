import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import {
  choiceToDecision,
  DEFAULT_PERMISSION_CHOICES,
  PermissionOverlay,
} from "./PermissionOverlay"
import type { PermissionRequestEvent } from "../../state/types"

const req = {
  toolName: "bash",
  input: { command: "rm -rf /tmp/x" },
  displayName: "Run command",
  description: "Executes a shell command",
} as unknown as PermissionRequestEvent

describe("choiceToDecision", () => {
  it("maps deny to a decision with a message", () => {
    expect(choiceToDecision({ label: "Deny", value: "deny" }, "bash")).toEqual({
      decision: "deny",
      message: 'Denied "bash".',
    })
  })
  it("maps allow / allow_always to a plain decision", () => {
    expect(choiceToDecision({ label: "Allow", value: "allow" }, "bash")).toEqual({
      decision: "allow",
    })
    expect(choiceToDecision({ label: "Always", value: "allow_always" }, "bash")).toEqual({
      decision: "allow_always",
    })
  })
})

describe("PermissionOverlay", () => {
  beforeEach(() => __resetInk())

  it("shows the tool, summary and description", () => {
    const { container } = render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={() => {}}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Run command")
    expect(text).toContain("rm -rf /tmp/x")
    expect(text).toContain("Executes a shell command")
    expect(text).toContain("Allow once")
  })

  it("resolves the highlighted decision on Enter", () => {
    const onResolve = jest.fn()
    render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={1}
        onMove={() => {}}
        onResolve={onResolve}
      />
    )
    __fireInput("", { return: true })
    expect(onResolve).toHaveBeenCalledWith({ decision: "allow_always" })
  })

  it("denies on Escape", () => {
    const onResolve = jest.fn()
    render(
      <PermissionOverlay
        req={req}
        choices={DEFAULT_PERMISSION_CHOICES}
        index={0}
        onMove={() => {}}
        onResolve={onResolve}
      />
    )
    __fireInput("", { escape: true })
    expect(onResolve).toHaveBeenCalledWith({ decision: "deny", message: 'Denied "bash".' })
  })
})
