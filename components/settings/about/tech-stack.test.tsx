/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

const openExternalMock = jest.fn(async (_u: string) => {})
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (u: string) => openExternalMock(u) }))

import { TechStack } from "./tech-stack"

describe("<TechStack />", () => {
  it("renders every credited project", () => {
    render(<TechStack />)
    const grid = screen.getByTestId("acknowledgements")
    for (const name of [
      "Next.js",
      "React",
      "Tauri",
      "Capacitor",
      "Tailwind CSS",
      "shadcn/ui",
      "Radix UI",
      "Zustand",
      "next-intl",
    ]) {
      expect(grid).toHaveTextContent(name)
    }
  })

  it("renders a brand mark for each tile", () => {
    render(<TechStack />)
    const tiles = screen.getAllByRole("listitem")
    expect(tiles).toHaveLength(9)
    for (const tile of tiles) {
      expect(tile.querySelector("svg")).not.toBeNull()
    }
  })

  it("opens the project site on click", () => {
    render(<TechStack />)
    fireEvent.click(screen.getByTestId("stack-React"))
    expect(openExternalMock).toHaveBeenCalledWith("https://react.dev")
    fireEvent.click(screen.getByTestId("stack-Tauri"))
    expect(openExternalMock).toHaveBeenCalledWith("https://tauri.app")
    fireEvent.click(screen.getByTestId("stack-next-intl"))
    expect(openExternalMock).toHaveBeenCalledWith("https://next-intl.dev")
  })
})
