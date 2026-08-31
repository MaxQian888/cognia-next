import { fireEvent, render, screen } from "@testing-library/react"

import { PluginImage } from "./plugin-image"

describe("PluginImage", () => {
  it("renders a lazy themed image and collapses after a load failure", () => {
    const onError = jest.fn()
    render(<PluginImage src="data:image/png;base64,AAAA" alt="Preview" onError={onError} />)
    const image = screen.getByRole("img", { name: "Preview" })
    expect(image).toHaveAttribute("data-slot", "plugin-image")
    expect(image).toHaveAttribute("loading", "lazy")
    fireEvent.error(image)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("img", { name: "Preview" })).not.toBeInTheDocument()
  })
})
