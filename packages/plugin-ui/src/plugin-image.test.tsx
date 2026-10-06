import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { bindPluginImageAssetResolver, PluginImage } from "./plugin-image"

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

it("resolves a plugin-relative image through the host and recovers when its source changes", async () => {
  const resolve = jest.fn(async (_id: string, src: string) => `data:image/webp;base64,${src}`)
  bindPluginImageAssetResolver(resolve)
  const view = render(<PluginImage pluginId="demo" src="assets/one.webp" alt="Owned" />)
  expect(await screen.findByRole("img", { name: "Owned" })).toHaveAttribute(
    "src",
    "data:image/webp;base64,assets/one.webp"
  )
  expect(resolve).toHaveBeenCalledWith("demo", "assets/one.webp")
  fireEvent.error(screen.getByRole("img", { name: "Owned" }))
  view.rerender(<PluginImage pluginId="demo" src="assets/two.webp" alt="Owned" />)
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Owned" })).toHaveAttribute(
      "src",
      "data:image/webp;base64,assets/two.webp"
    )
  )
})

it("hides assets rejected by the host instead of loading a raw relative URL", async () => {
  bindPluginImageAssetResolver(async () => {
    throw new Error("unsafe path")
  })
  render(<PluginImage pluginId="demo" src="../outside.webp" alt="Rejected" />)
  await waitFor(() =>
    expect(screen.queryByRole("img", { name: "Rejected" })).not.toBeInTheDocument()
  )
})
