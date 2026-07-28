/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { RetrievalModeAlert } from "./retrieval-mode-alert"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))

describe("RetrievalModeAlert", () => {
  it("shows a probe skeleton until the retrieval mode resolves", () => {
    render(
      <RetrievalModeAlert
        mode={undefined}
        onEnableHybrid={jest.fn()}
        onAllowCloudEmbedding={jest.fn()}
      />
    )
    expect(screen.getByTestId("memory-retrieval-probing")).toBeInTheDocument()
  })

  it("offers the matching repair for degraded retrieval", () => {
    const onEnableHybrid = jest.fn()
    render(
      <RetrievalModeAlert
        mode={{ kind: "bm25", reason: "hybrid_disabled" }}
        onEnableHybrid={onEnableHybrid}
        onAllowCloudEmbedding={jest.fn()}
      />
    )

    expect(screen.getByRole("status")).toHaveAttribute("data-reason", "hybrid_disabled")
    fireEvent.click(screen.getByRole("button", { name: "Enable hybrid retrieval" }))
    expect(onEnableHybrid).toHaveBeenCalledTimes(1)
  })

  it("hides healthy and disabled states when no guidance is useful", () => {
    const { rerender } = render(
      <RetrievalModeAlert
        mode={{ kind: "hybrid", provider: "local" }}
        onEnableHybrid={jest.fn()}
        onAllowCloudEmbedding={jest.fn()}
        quietWhenHealthy
      />
    )
    expect(screen.queryByTestId("memory-retrieval-alert")).not.toBeInTheDocument()

    rerender(
      <RetrievalModeAlert
        mode={{ kind: "off", reason: "disabled" }}
        onEnableHybrid={jest.fn()}
        onAllowCloudEmbedding={jest.fn()}
      />
    )
    expect(screen.queryByTestId("memory-retrieval-alert")).not.toBeInTheDocument()
  })
})
