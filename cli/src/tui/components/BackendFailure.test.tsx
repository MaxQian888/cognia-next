import React from "react"
import { render } from "@testing-library/react"
import { __fireInput, __resetInk } from "ink"

import {
  BACKEND_FAILURE_CHOICE_COUNT,
  BackendFailure,
  backendFailureAction,
  failureChoices,
  type BackendFailureAction,
} from "./BackendFailure"
import type { BackendConnectFailure } from "../runtime/backend-controller"
import type { BackendInstallOption } from "../state/types"

const failure: BackendConnectFailure = {
  kind: "launcher",
  stage: "sandbox",
  message: "The sandbox launcher that isolates external agents is missing.",
  hint: "Reinstall cognia-agent, or set COGNIA_EXTERNAL_AGENT_LAUNCHER.",
}

const commandFailure: BackendConnectFailure = {
  kind: "command",
  stage: "command",
  message: `"copilot" isn't installed or isn't on PATH.`,
  command: "copilot",
}

const installOption: BackendInstallOption = {
  command: "copilot",
  name: "GitHub Copilot CLI",
  method: {
    kind: "npm",
    label: "npm",
    display: "npm install -g @github/copilot",
    command: "npm",
    args: ["install", "-g", "@github/copilot"],
    requires: ["npm"],
  },
}

function renderPage(
  overrides: {
    failure?: BackendConnectFailure
    installOption?: BackendInstallOption
    index?: number
    onSelect?: (action: BackendFailureAction) => void
    onIndexChange?: (index: number) => void
  } = {}
) {
  const onSelect = overrides.onSelect ?? jest.fn()
  const onIndexChange = overrides.onIndexChange ?? jest.fn()
  const { container } = render(
    <BackendFailure
      backend="codex"
      failure={overrides.failure ?? failure}
      installOption={overrides.installOption}
      index={overrides.index ?? 0}
      onIndexChange={onIndexChange}
      onSelect={onSelect}
    />
  )
  return { text: container.textContent ?? "", onSelect, onIndexChange }
}

describe("BackendFailure", () => {
  beforeEach(() => __resetInk())

  it("pins the failure to the step it happened on and offers a way out", () => {
    const { text } = renderPage()
    expect(text).toContain("Couldn't start codex — failed while checking sandbox.")
    expect(text).toContain("sandbox launcher")
    expect(text).toContain("COGNIA_EXTERNAL_AGENT_LAUNCHER")
    expect(text).toContain("Retry")
    // Falling back silently would leave the user believing codex answered.
    expect(text).toContain("Use the built-in agent instead")
    expect(text).toContain("Quit")
  })

  it("renders without a hint when the failure has none", () => {
    const { text } = renderPage({
      failure: { kind: "handshake", stage: "launch", message: "not logged in" },
    })
    expect(text).toContain("not logged in")
    expect(text).toContain("failed while starting agent")
  })

  it("selects the highlighted recovery action on Enter", () => {
    const { onSelect } = renderPage({ index: 1 })
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("builtin")
  })

  it("reports the resolved index to the caller that owns it", () => {
    const { onIndexChange } = renderPage({ index: 0 })
    __fireInput("", { downArrow: true })
    expect(onIndexChange).toHaveBeenCalledWith(1)
  })

  it("wraps from the first entry to the last, matching the trust gate's list", () => {
    const { onIndexChange } = renderPage({ index: 0 })
    __fireInput("", { upArrow: true })
    expect(onIndexChange).toHaveBeenCalledWith(BACKEND_FAILURE_CHOICE_COUNT - 1)
  })
})

describe("BackendFailure install choice", () => {
  beforeEach(() => __resetInk())

  it("offers Install as the first choice for a missing-command failure", () => {
    const { text } = renderPage({ failure: commandFailure, installOption })
    expect(text).toContain("Install GitHub Copilot CLI (npm)")
    // Index 0 is now the install action, not retry.
    const { onSelect } = renderPage({ failure: commandFailure, installOption, index: 0 })
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("install")
  })

  it("still offers the base recovery choices below Install", () => {
    const { onSelect } = renderPage({ failure: commandFailure, installOption, index: 1 })
    __fireInput("", { return: true })
    expect(onSelect).toHaveBeenCalledWith("retry")
  })

  it("omits Install when there is no runnable install option", () => {
    const { text } = renderPage({ failure: commandFailure })
    expect(text).not.toContain("Install")
  })

  it("omits Install for a non-command failure even if an option is somehow present", () => {
    expect(failureChoices(failure, installOption).some((c) => c.action === "install")).toBe(false)
  })
})

describe("backendFailureAction", () => {
  it("maps each position to its action and clamps out-of-range input", () => {
    expect(backendFailureAction(0)).toBe("retry")
    expect(backendFailureAction(1)).toBe("builtin")
    expect(backendFailureAction(2)).toBe("doctor")
    expect(backendFailureAction(3)).toBe("quit")
    expect(backendFailureAction(-5)).toBe("retry")
    expect(backendFailureAction(99)).toBe("quit")
    expect(BACKEND_FAILURE_CHOICE_COUNT).toBe(4)
  })
})
