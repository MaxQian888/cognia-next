import { render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { useHasMounted } from "./use-has-mounted"

function Probe() {
  return <span>{useHasMounted() ? "mounted" : "server"}</span>
}

describe("useHasMounted", () => {
  it("is false while rendering on the server", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("server")
  })

  it("is true once hydrated on the client", () => {
    render(<Probe />)
    expect(screen.getByText("mounted")).toBeInTheDocument()
  })

  it("stays true across re-renders", () => {
    const { rerender } = render(<Probe />)
    rerender(<Probe />)
    expect(screen.getByText("mounted")).toBeInTheDocument()
  })
})
