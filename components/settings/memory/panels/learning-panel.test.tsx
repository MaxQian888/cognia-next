/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"
import { LearningPanel } from "./learning-panel"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

describe("LearningPanel", () => {
  it("updates the learning policy from the primary switch", () => {
    const update = jest.fn()
    render(<LearningPanel config={DEFAULT_MEMORY_CONFIG} update={update} />)

    fireEvent.click(screen.getByRole("switch", { name: "Learn from chats" }))
    expect(update).toHaveBeenCalledWith({ learnFromChats: false })
  })

  it("gates dependent controls when learning is disabled", () => {
    render(
      <LearningPanel
        config={{ ...DEFAULT_MEMORY_CONFIG, learnFromChats: false }}
        update={jest.fn()}
      />
    )

    expect(screen.getByTestId("memory-gate-reason")).toHaveTextContent(
      "Turn on learning from chats"
    )
    expect(
      screen.getByRole("switch", { name: "Extract automatically" }).closest("[inert]")
    ).not.toBeNull()
  })
})
