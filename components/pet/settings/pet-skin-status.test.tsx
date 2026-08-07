import { fireEvent, render, screen } from "@testing-library/react"
import { PetSkinStatus } from "./pet-skin-status"

describe("PetSkinStatus", () => {
  it("shows requested and effective skins with an exact resource diagnostic", () => {
    render(
      <PetSkinStatus
        requestedSkinId="live2d"
        effectiveSkinId="svg"
        diagnostics={[
          {
            code: "missingOptionalResource",
            severity: "warning",
            path: "motions/wave.motion3.json",
            recoverable: true,
          },
        ]}
      />
    )

    expect(screen.getByText(/requested.*live2d/i)).toBeInTheDocument()
    expect(screen.getByText(/effective.*vector mascot/i)).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("motions/wave.motion3.json")
    expect(screen.getByText(/fallback/i)).toBeInTheDocument()
  })

  it("offers functional retry and configure actions when supplied", () => {
    const onRetry = jest.fn()
    const onConfigure = jest.fn()
    render(
      <PetSkinStatus
        requestedSkinId="live2d"
        effectiveSkinId="svg"
        diagnostics={[{ code: "contextLost", severity: "error", recoverable: true }]}
        onRetry={onRetry}
        onConfigure={onConfigure}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    fireEvent.click(screen.getByRole("button", { name: /configure/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onConfigure).toHaveBeenCalledTimes(1)
  })

  it("stays quiet for a ready skin without diagnostics", () => {
    const { container } = render(
      <PetSkinStatus requestedSkinId="sprite-v2" effectiveSkinId="sprite-v2" diagnostics={[]} />
    )
    expect(container.firstChild).toBeNull()
  })
})
