/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { HoverScrollText } from "./hover-scroll-text"

describe("HoverScrollText", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("reduce-motion")
    document.documentElement.removeAttribute("data-reduce-motion")
    document.documentElement.style.setProperty("--motion-duration-scale", "1")
    window.matchMedia = jest.fn().mockReturnValue({ matches: false })
  })

  afterEach(() => {
    document.documentElement.style.removeProperty("--motion-duration-scale")
  })

  it("keeps the complete text in the DOM while truncating it visually", () => {
    render(<HoverScrollText text="A complete conversation title" />)

    const text = screen.getByText("A complete conversation title")
    expect(text).toHaveClass("truncate")
    expect(text).toHaveTextContent("A complete conversation title")
  })

  it("scrolls an overflowing title to its measured end after hover", () => {
    render(<HoverScrollText text="A complete conversation title" />)

    const text = screen.getByText("A complete conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })

    fireEvent.mouseEnter(viewport)

    expect(text).toHaveAttribute("data-scrolling", "true")
    expect(text.style.getPropertyValue("--hover-scroll-distance")).toBe("-144px")
    expect(text.style.getPropertyValue("--hover-scroll-content-width")).toBe("244px")
    expect(text.style.getPropertyValue("--hover-scroll-duration")).toBe("3000ms")
    expect(text.style.getPropertyValue("--hover-scroll-delay")).toBe("400ms")
    expect(text.style.getPropertyValue("--hover-scroll-cycle-duration")).toBe("6800ms")
  })

  it("keeps overflowing text static when motion is disabled", () => {
    render(<HoverScrollText text="A complete conversation title" motion="off" />)

    const text = screen.getByText("A complete conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })

    fireEvent.mouseEnter(viewport)

    expect(text).not.toHaveAttribute("data-scrolling")
    expect(text).toHaveClass("truncate")
    expect(viewport).toHaveAttribute("data-motion", "off")
    expect(viewport).toHaveAttribute("title", "A complete conversation title")
  })

  it("keeps reduced-motion titles truncated and exposes a static hover fallback", () => {
    document.documentElement.classList.add("reduce-motion")
    render(<HoverScrollText text="A complete conversation title" />)

    const text = screen.getByText("A complete conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })

    fireEvent.mouseEnter(viewport)

    expect(text).not.toHaveAttribute("data-scrolling")
    expect(text).toHaveClass("truncate")
    expect(viewport).toHaveAttribute("title", "A complete conversation title")
  })

  it("also honors the legacy reduced-motion preference mirrored by the app shell", () => {
    document.documentElement.setAttribute("data-reduce-motion", "true")
    render(<HoverScrollText text="A complete conversation title" />)

    const text = screen.getByText("A complete conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })

    fireEvent.mouseEnter(viewport)

    expect(text).not.toHaveAttribute("data-scrolling")
    expect(viewport).toHaveAttribute("title", "A complete conversation title")
  })

  it("honors the operating system reduced-motion preference", () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true })
    render(<HoverScrollText text="A complete conversation title" />)

    const text = screen.getByText("A complete conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })

    fireEvent.mouseEnter(viewport)

    expect(text).not.toHaveAttribute("data-scrolling")
    expect(viewport).toHaveAttribute("title", "A complete conversation title")
  })

  it("does not animate text that fits inside the viewport", () => {
    render(<HoverScrollText text="Short title" />)

    const text = screen.getByText("Short title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 101 })

    fireEvent.mouseEnter(viewport)

    expect(text).not.toHaveAttribute("data-scrolling")
    expect(text).toHaveClass("truncate")
  })

  it("restores truncation immediately when the pointer leaves", () => {
    render(<HoverScrollText text="A complete conversation title" />)

    const text = screen.getByText("A complete conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })
    fireEvent.mouseEnter(viewport)

    fireEvent.mouseLeave(viewport)

    expect(text).not.toHaveAttribute("data-scrolling")
    expect(text).toHaveClass("truncate")
    expect(text.style.getPropertyValue("--hover-scroll-distance")).toBe("")
  })

  it("invalidates an active scroll when the displayed title changes", () => {
    const { rerender } = render(<HoverScrollText text="The original conversation title" />)

    const original = screen.getByText("The original conversation title")
    const viewport = original.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(original, "scrollWidth", { configurable: true, value: 244 })
    fireEvent.mouseEnter(viewport)

    rerender(<HoverScrollText text="A freshly generated title" />)

    const updated = screen.getByText("A freshly generated title")
    expect(updated).not.toHaveAttribute("data-scrolling")
    expect(updated).toHaveClass("truncate")
  })

  it("scales the minimum animation duration with the motion speed preference", () => {
    document.documentElement.style.setProperty("--motion-duration-scale", "0.5")
    render(<HoverScrollText text="A slightly overflowing conversation title" />)

    const text = screen.getByText("A slightly overflowing conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 124 })
    fireEvent.mouseEnter(viewport)

    expect(text.style.getPropertyValue("--hover-scroll-duration")).toBe("600ms")
    expect(text.style.getPropertyValue("--hover-scroll-delay")).toBe("200ms")
  })

  it("caps very long title animations at eight seconds", () => {
    render(<HoverScrollText text="An exceptionally long conversation title" />)

    const text = screen.getByText("An exceptionally long conversation title")
    const viewport = text.parentElement!
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
    Object.defineProperty(text, "scrollWidth", { configurable: true, value: 1_060 })
    fireEvent.mouseEnter(viewport)

    expect(text.style.getPropertyValue("--hover-scroll-duration")).toBe("8000ms")
  })
})
