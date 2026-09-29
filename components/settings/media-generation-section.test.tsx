/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("./media-generation/video-generation-card", () => ({
  VideoGenerationCard: () => <div>video-generation-card</div>,
}))

import { MediaGenerationSection } from "./media-generation-section"

it("renders the video generation defaults", () => {
  render(<MediaGenerationSection />)
  expect(screen.getByText("video-generation-card")).toBeInTheDocument()
})
