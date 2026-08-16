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
  it("offers every card whose capability was confirmed", () => {
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["fs", "ocr", "web"]}
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
        character={character}
        onChangeCharacter={jest.fn()}
        onPick={jest.fn()}
      />
    )
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeInTheDocument()
  })

  it("runs the picked card", async () => {
    const onPick = jest.fn().mockResolvedValue(undefined)
    render(
      <FirstRunStep
        shell="tauri"
        capabilities={["web"]}
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
        character={character}
        onChangeCharacter={onChangeCharacter}
        onPick={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId("onboarding-change-character"))
    expect(onChangeCharacter).toHaveBeenCalled()
  })
})
