/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `pet.quickMenu.${key}`,
}))

import { PetQuickMenu, type PetQuickMenuActions } from "./pet-quick-menu"

function makeActions(): jest.Mocked<Required<PetQuickMenuActions>> {
  return {
    onFeed: jest.fn(),
    onPlay: jest.fn(),
    onPet: jest.fn(),
    onTalk: jest.fn(),
    onSleep: jest.fn(),
    onClean: jest.fn(),
    onTreat: jest.fn(),
    onOpenConsole: jest.fn(),
    onToggleDesktopPet: jest.fn(),
    onMinimize: jest.fn(),
    onOpenSettings: jest.fn(),
  }
}

/** Open the context menu by right-clicking the trigger. */
function openMenu() {
  fireEvent.contextMenu(screen.getByTestId("trigger"))
}

function label(key: string) {
  return new RegExp(`^pet\\.quickMenu\\.${key}$`)
}

describe("PetQuickMenu", () => {
  it("shows every care action plus console/minimize/settings and fires handlers", async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(
      <PetQuickMenu actions={actions}>
        <button data-testid="trigger">pet</button>
      </PetQuickMenu>
    )
    openMenu()

    // Every action available in the interaction panel is reachable here too.
    expect(screen.getByText(label("feed"))).toBeInTheDocument()
    expect(screen.getByText(label("play"))).toBeInTheDocument()
    expect(screen.getByText(label("pet"))).toBeInTheDocument()
    expect(screen.getByText(label("talk"))).toBeInTheDocument()
    expect(screen.getByText(label("sleep"))).toBeInTheDocument()
    expect(screen.getByText(label("clean"))).toBeInTheDocument()
    expect(screen.getByText(label("treat"))).toBeInTheDocument()
    expect(screen.getByText(label("openConsole"))).toBeInTheDocument()
    expect(screen.getByText(label("minimize"))).toBeInTheDocument()
    expect(screen.getByText(label("openSettings"))).toBeInTheDocument()

    await user.click(screen.getByText(label("feed")))
    expect(actions.onFeed).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("play")))
    expect(actions.onPlay).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("pet")))
    expect(actions.onPet).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("talk")))
    expect(actions.onTalk).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("sleep")))
    expect(actions.onSleep).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("clean")))
    expect(actions.onClean).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("treat")))
    expect(actions.onTreat).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("openConsole")))
    expect(actions.onOpenConsole).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("minimize")))
    expect(actions.onMinimize).toHaveBeenCalledTimes(1)

    openMenu()
    await user.click(screen.getByText(label("openSettings")))
    expect(actions.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("hides the desktop-pet toggle unless showDesktopPetItems", () => {
    const actions = makeActions()
    const { rerender } = render(
      <PetQuickMenu actions={actions}>
        <button data-testid="trigger">pet</button>
      </PetQuickMenu>
    )
    openMenu()
    expect(screen.queryByText(label("showDesktopPet"))).toBeNull()
    expect(screen.queryByText(label("hideDesktopPet"))).toBeNull()

    // Press Escape to close, then re-render with the gate enabled.
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" })
    rerender(
      <PetQuickMenu actions={actions} showDesktopPetItems>
        <button data-testid="trigger">pet</button>
      </PetQuickMenu>
    )
    openMenu()
    expect(screen.getByText(label("showDesktopPet"))).toBeInTheDocument()
  })

  it("switches the desktop-pet toggle label and fires the handler", async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(
      <PetQuickMenu actions={actions} showDesktopPetItems desktopPetOpen>
        <button data-testid="trigger">pet</button>
      </PetQuickMenu>
    )
    openMenu()
    expect(screen.getByText(label("hideDesktopPet"))).toBeInTheDocument()
    expect(screen.queryByText(label("showDesktopPet"))).toBeNull()
    await user.click(screen.getByText(label("hideDesktopPet")))
    expect(actions.onToggleDesktopPet).toHaveBeenCalledTimes(1)
  })

  it("forwards open-state changes through onOpenChange", () => {
    const onOpenChange = jest.fn()
    const actions = makeActions()
    render(
      <PetQuickMenu actions={actions} onOpenChange={onOpenChange}>
        <div data-testid="trigger">pet</div>
      </PetQuickMenu>
    )
    act(() => openMenu())
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })
})
