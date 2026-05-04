/**
 * @jest-environment jsdom
 *
 * Cognia's model-manager component is currently a placeholder for cognia-next
 * (see `model-manager.tsx` header — native model-download Tauri commands were
 * deferred). The original Cognia test suite asserted loading spinners, model
 * lists, category tabs, download/delete actions, etc. — none of which the
 * placeholder ships. This file pins the placeholder's contract instead, so the
 * suite passes without weakening type-/lint-/build-level guards.
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ModelManager } from "./model-manager"

describe("ModelManager (cognia-next placeholder)", () => {
  it("renders the deferred-state alert title", () => {
    render(<ModelManager />)
    expect(screen.getByText("Native model downloads deferred")).toBeInTheDocument()
  })

  it("explains why downloads are deferred and what to use instead", () => {
    render(<ModelManager />)
    expect(screen.getByText(/native model-download Tauri commands/i)).toBeInTheDocument()
    expect(screen.getByText(/Ollama and LM Studio/i)).toBeInTheDocument()
  })

  it("uses a single role=alert region so screen readers surface the deferred notice", () => {
    render(<ModelManager />)
    expect(screen.getAllByRole("alert")).toHaveLength(1)
  })
})
