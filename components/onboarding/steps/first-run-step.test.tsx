/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Character } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key,
}))

jest.mock("@/components/desktop/avatar-badge", () => ({
  AvatarBadge: () => <span data-testid="avatar" />,
}))

import { FirstRunStep } from "./first-run-step"

const character = { id: "c1", name: "Ada" } as Character

describe("FirstRunStep", () => {
  it("disables the cards when this device cannot reach a model", () => {
    // Running a card creates a session, queues its prompt and records the flow
    // as completed — so an ungated click reported success and handed the user
    // a turn that failed in the chat pane a moment later.
    const onPick = jest.fn()
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess={false}
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={onPick}
      />
    )
    expect(screen.getByTestId("onboarding-first-run-blocked")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeDisabled()
    fireEvent.click(screen.getByTestId("onboarding-card-summarize-web"))
    expect(onPick).not.toHaveBeenCalled()
  })

  it("offers the way back to sign-in rather than only refusing", () => {
    const onConnectModel = jest.fn()
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess={false}
        onConnectModel={onConnectModel}
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-first-run-connect"))
    expect(onConnectModel).toHaveBeenCalled()
  })

  it("does not block a shell that has nothing local to probe", () => {
    // A paired phone reports `null`: its credentials live on the desktop it
    // pairs with, so a local "no model" verdict would be about the wrong
    // machine.
    render(
      <FirstRunStep
        shell="mobile-paired"
        capabilities={["web"]}
        modelAccess={null}
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(screen.queryByTestId("onboarding-first-run-blocked")).toBeNull()
    expect(screen.getByTestId("onboarding-card-summarize-web")).not.toBeDisabled()
  })

  it("offers every card whose capability was confirmed", () => {
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["fs", "ocr", "web"]}
        modelAccess
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(screen.getByTestId("onboarding-card-read-folder")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-card-extract-text")).toBeInTheDocument()
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeInTheDocument()
  })

  it("hides — not disables — a card whose capability is missing", () => {
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(screen.queryByTestId("onboarding-card-read-folder")).toBeNull()
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeInTheDocument()
  })

  it("never renders an empty step, even with nothing probed", () => {
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={[]}
        modelAccess
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeInTheDocument()
  })

  it("hides the footer row when it has nothing to say", () => {
    // An empty row still painted its top border, leaving a hairline under the
    // grid with nothing beneath it.
    const { container } = render(
      <FirstRunStep
        shell="web"
        capabilities={["web"]}
        modelAccess
        character={null}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(container.querySelector(".border-t")).toBeNull()
  })

  it("runs the picked card", async () => {
    const onPick = jest.fn().mockResolvedValue(undefined)
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={onPick}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-card-summarize-web"))
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "summarize-web" }))
    )
  })

  it("surfaces a failed run without leaving the step", async () => {
    const onPick = jest.fn().mockRejectedValue(new Error("boom"))
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={onPick}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-card-summarize-web"))
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-first-run-failed")).toBeInTheDocument()
    )
  })

  it("omits the character row while the builtin set is still seeding", () => {
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess
        character={null}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(screen.queryByTestId("onboarding-character")).toBeNull()
  })

  it("names the runtime that will execute so it is never a mystery", () => {
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
        runtimeLabel="Claude Code"
      />
    )
    expect(screen.getByText("firstRun.runtimeLine:Claude Code")).toBeInTheDocument()
  })

  it("lets the user swap character from the card grid", () => {
    const onChangeCharacter = jest.fn()
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
        modelAccess
        character={character}
        onChangeCharacter={onChangeCharacter}
        onPick={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-change-character"))
    expect(onChangeCharacter).toHaveBeenCalled()
  })
})
