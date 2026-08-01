/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { STAGES } from "@/lib/skills/recording/state-machine"

import { RecorderStageHeader } from "./recorder-stage-header"

function renderHeader(props: Partial<React.ComponentProps<typeof RecorderStageHeader>> = {}) {
  const onSelect = jest.fn()
  render(
    <RecorderStageHeader
      current="review"
      reached={["setup", "recording", "review"]}
      onSelect={onSelect}
      {...props}
    />
  )
  return { onSelect }
}

describe("RecorderStageHeader", () => {
  it("always shows all five stages", () => {
    renderHeader()
    expect(screen.getAllByRole("button")).toHaveLength(STAGES.length)
    for (const stage of STAGES) {
      expect(
        screen.getByRole("button", { name: new RegExp(`stages\\.${stage}`) })
      ).toBeInTheDocument()
    }
  })

  it("marks the current stage for assistive technology", () => {
    renderHeader()
    const current = screen.getByRole("button", { name: /stages\.review/ })
    expect(current).toHaveAttribute("aria-current", "step")
    expect(screen.getByRole("button", { name: /stages\.setup/ })).not.toHaveAttribute(
      "aria-current"
    )
  })

  it("names the position in the flow on the list itself", () => {
    renderHeader()
    expect(
      screen.getByRole("list", { name: /stages\.stepOf.*"current":3.*"total":5/ })
    ).toBeInTheDocument()
  })

  it("lets the user step back to a completed stage", async () => {
    // Going back to review after generating is a normal thing to want.
    const { onSelect } = renderHeader()
    await userEvent.click(screen.getByRole("button", { name: /stages\.recording/ }))
    expect(onSelect).toHaveBeenCalledWith("recording")
  })

  it("refuses to jump ahead to a stage the flow cannot be at yet", async () => {
    // Offering "Save" before there is anything to save is a lie about the flow.
    const { onSelect } = renderHeader()
    const ahead = screen.getByRole("button", { name: /stages\.save/ })
    expect(ahead).toBeDisabled()
    await userEvent.click(ahead)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("refuses to re-select the current stage", () => {
    renderHeader()
    expect(screen.getByRole("button", { name: /stages\.review/ })).toBeDisabled()
  })

  it("treats an un-reached earlier stage as unreachable", () => {
    renderHeader({ reached: ["setup", "review"] })
    expect(screen.getByRole("button", { name: /stages\.recording/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /stages\.setup/ })).toBeEnabled()
  })

  it("is inert when no handler is supplied", () => {
    render(<RecorderStageHeader current="review" reached={["setup", "recording", "review"]} />)
    expect(screen.getByRole("button", { name: /stages\.setup/ })).toBeDisabled()
  })

  it("puts the first stage as current at the start of the flow", () => {
    renderHeader({ current: "setup", reached: ["setup"] })
    expect(screen.getByRole("button", { name: /stages\.setup/ })).toHaveAttribute(
      "aria-current",
      "step"
    )
    expect(screen.getByRole("list", { name: /"current":1/ })).toBeInTheDocument()
  })
})
