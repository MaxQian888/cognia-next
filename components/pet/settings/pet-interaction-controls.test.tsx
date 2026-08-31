import { render, screen, fireEvent } from "@testing-library/react"

const clearPetConversation = jest.fn()
jest.mock("@/lib/db/pet-conversation", () => ({
  clearPetConversation: () => clearPetConversation(),
}))
jest.mock("@/components/settings/common/model-override-fields", () => ({
  useUtilityProviderOptions: () => [],
  ModelOverrideFields: () => <div data-testid="model-override" />,
}))

import { PetInteractionControls } from "./pet-interaction-controls"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

beforeEach(() => clearPetConversation.mockClear())

describe("PetInteractionControls", () => {
  it("toggles muted bubbles and reveals the model override when LLM speak is on", () => {
    const patch = jest.fn()
    const { rerender } = render(<PetInteractionControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.click(document.getElementById("pet-muted") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ mutedBubbles: true })
    expect(screen.queryByTestId("model-override")).toBeNull()
    expect(document.getElementById("pet-proactive-enabled")).toBeNull()

    const withLlm: PetSettings = { ...DEFAULT_PET_SETTINGS, llmSpeak: { enabled: true } }
    rerender(<PetInteractionControls pet={withLlm} patch={patch} />)
    expect(screen.getByTestId("model-override")).toBeInTheDocument()
    expect(document.getElementById("pet-proactive-enabled")).not.toBeNull()
  })

  it("clears conversation memory", () => {
    const withLlm: PetSettings = { ...DEFAULT_PET_SETTINGS, llmSpeak: { enabled: true } }
    render(<PetInteractionControls pet={withLlm} patch={jest.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /clear pet memory/i }))
    expect(clearPetConversation).toHaveBeenCalled()
  })

  it("keeps conversation memory controls available when LLM bubbles are disabled", () => {
    const patch = jest.fn()
    render(<PetInteractionControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)

    fireEvent.click(document.getElementById("pet-memory-enabled") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ petMemory: { enabled: false } })
    fireEvent.click(screen.getByRole("button", { name: /clear pet memory/i }))
    expect(clearPetConversation).toHaveBeenCalled()
  })

  it("drives the llm-speak, proactive, and memory controls", () => {
    const patch = jest.fn()
    const full: PetSettings = {
      ...DEFAULT_PET_SETTINGS,
      llmSpeak: { enabled: true },
      proactive: {
        enabled: true,
        tier: "normal",
        eventComments: true,
        idleChatter: true,
        timeGreetings: true,
      },
    }
    render(<PetInteractionControls pet={full} patch={patch} />)
    fireEvent.click(document.getElementById("pet-llm-speak") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ llmSpeak: { enabled: false } })
    fireEvent.click(screen.getByRole("radio", { name: /quiet/i }))
    expect(patch).toHaveBeenCalledWith({ proactive: expect.objectContaining({ tier: "quiet" }) })
    fireEvent.click(document.getElementById("pet-proactive-events") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({
      proactive: expect.objectContaining({ eventComments: false }),
    })
    fireEvent.click(document.getElementById("pet-proactive-idle") as HTMLButtonElement)
    fireEvent.click(document.getElementById("pet-proactive-greetings") as HTMLButtonElement)
    fireEvent.click(document.getElementById("pet-proactive-enabled") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ proactive: expect.objectContaining({ enabled: false }) })
    fireEvent.click(document.getElementById("pet-memory-enabled") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ petMemory: { enabled: false } })
  })

  it("ignores blank catchphrase submissions and enforces the max count", () => {
    const patch = jest.fn()
    const { rerender } = render(<PetInteractionControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    const input = screen.getByLabelText(/catchphrases|customBubbles\.label/i)
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(patch).not.toHaveBeenCalled()
    // At the cap, the add button + input are disabled.
    const full: PetSettings = {
      ...DEFAULT_PET_SETTINGS,
      customBubbles: Array.from({ length: 12 }, (_, i) => `p${i}`),
    }
    rerender(<PetInteractionControls pet={full} patch={patch} />)
    expect(screen.getByLabelText(/add catchphrase|customBubbles\.add/i)).toBeDisabled()
  })

  it("adds and removes custom catchphrases", () => {
    const patch = jest.fn()
    render(<PetInteractionControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    const input = screen.getByLabelText(/catchphrases|customBubbles\.label/i)
    fireEvent.change(input, { target: { value: "  meow meow  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(patch).toHaveBeenCalledWith({ customBubbles: ["meow meow"] })
  })

  it("removes an existing catchphrase", () => {
    const patch = jest.fn()
    const withPhrases: PetSettings = { ...DEFAULT_PET_SETTINGS, customBubbles: ["hi", "bye"] }
    render(<PetInteractionControls pet={withPhrases} patch={patch} />)
    fireEvent.click(screen.getByRole("button", { name: /remove.*hi/i }))
    expect(patch).toHaveBeenCalledWith({ customBubbles: ["bye"] })
  })
})
