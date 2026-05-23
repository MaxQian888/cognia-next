/**
 * Tests for ThreeSceneRichOutput.
 *
 * jsdom can't host the real WebGL canvas, so @react-three/fiber and
 * @react-three/drei are mocked. The test verifies the wrapper renders the
 * optional prompt and dimensions correctly.
 */

import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("@react-three/fiber", () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="three-canvas">{children}</div>
  ),
  useFrame: () => undefined,
}))

jest.mock("@react-three/drei", () => ({
  OrbitControls: () => <div data-testid="three-orbit-controls" />,
}))

import { ThreeSceneRichOutput } from "./three-scene-rich-output"

describe("ThreeSceneRichOutput", () => {
  it("renders the canvas wrapper without a prompt by default", () => {
    render(<ThreeSceneRichOutput />)
    expect(screen.getByTestId("three-canvas")).toBeInTheDocument()
  })

  it("renders the optional prompt label", () => {
    render(<ThreeSceneRichOutput prompt="Spinning torus" />)
    expect(screen.getByText("Spinning torus")).toBeInTheDocument()
  })

  it("applies the height prop to the inner sizing container", () => {
    const { container } = render(<ThreeSceneRichOutput height={120} />)
    // height is set on the immediate parent div around the Canvas
    const heightHost = container.querySelector("div[style]") as HTMLElement | null
    expect(heightHost).not.toBeNull()
    expect(heightHost?.style.height).toBe("120px")
  })

  it("mounts the OrbitControls helper inside the Canvas", () => {
    render(<ThreeSceneRichOutput />)
    expect(screen.getByTestId("three-orbit-controls")).toBeInTheDocument()
  })
})
