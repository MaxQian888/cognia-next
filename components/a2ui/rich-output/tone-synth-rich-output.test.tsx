/**
 * Tests for ToneSynthRichOutput.
 *
 * Tone.js is mocked so we don't hit Web Audio under jsdom.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

const startMock = jest.fn(() => Promise.resolve())
const triggerAttackReleaseMock = jest.fn()
const toDestinationMock = jest.fn(function (this: { triggerAttackRelease: jest.Mock }) {
  return this
})

jest.mock("tone", () => ({
  __esModule: true,
  start: () => startMock(),
  Synth: jest.fn(function (this: { toDestination: jest.Mock; triggerAttackRelease: jest.Mock }) {
    this.triggerAttackRelease = triggerAttackReleaseMock
    this.toDestination = toDestinationMock
    return this
  }),
}))

import { ToneSynthRichOutput } from "./tone-synth-rich-output"

describe("ToneSynthRichOutput", () => {
  beforeEach(() => {
    startMock.mockClear()
    triggerAttackReleaseMock.mockClear()
    toDestinationMock.mockClear()
  })

  it("renders the play button", () => {
    render(<ToneSynthRichOutput />)
    expect(screen.getByRole("button", { name: /play synth/i })).toBeInTheDocument()
  })

  it("renders the optional prompt", () => {
    render(<ToneSynthRichOutput prompt="Tap to hear a C4 note" />)
    expect(screen.getByText(/Tap to hear a C4 note/)).toBeInTheDocument()
  })

  it("calls Tone.start and triggerAttackRelease when Play is clicked", async () => {
    render(<ToneSynthRichOutput />)
    fireEvent.click(screen.getByRole("button", { name: /play synth/i }))
    // start() is awaited inside the handler — flush the microtask queue
    await Promise.resolve()
    await Promise.resolve()
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(triggerAttackReleaseMock).toHaveBeenCalledWith("C4", "8n")
  })

  it("reuses the same Synth instance across clicks", async () => {
    const { Synth } = jest.requireMock("tone")
    render(<ToneSynthRichOutput />)
    const btn = screen.getByRole("button", { name: /play synth/i })
    fireEvent.click(btn)
    await Promise.resolve()
    await Promise.resolve()
    fireEvent.click(btn)
    await Promise.resolve()
    await Promise.resolve()
    expect(Synth).toHaveBeenCalledTimes(1)
    expect(triggerAttackReleaseMock).toHaveBeenCalledTimes(2)
  })
})
