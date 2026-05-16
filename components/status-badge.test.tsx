/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"

import { StatusBadge } from "./status-badge"

jest.mock("motion/react", () => ({
  motion: {
    span: ({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span className={className} data-testid="motion-span" {...props}>
        {children}
      </span>
    ),
  },
  useReducedMotion: jest.fn(() => false),
}))

const mockUseReducedMotion = jest.requireMock("motion/react").useReducedMotion

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    // Pretend "missingKey" is not in any namespace — return the canonical
    // "<namespace>.<key>" sentinel so the component falls back to raw value.
    if (key === "missingKey") return `${namespace}.${key}`
    return `${namespace}::${key}`
  },
}))

describe("StatusBadge", () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false)
  })

  it("renders the translated label via labelNamespace + value", () => {
    render(<StatusBadge value="running" labelNamespace="twin.status" />)
    expect(screen.getByText("twin.status::running")).toBeInTheDocument()
  })

  it("falls back to raw value when translation key is missing", () => {
    render(<StatusBadge value="missingKey" labelNamespace="twin.status" />)
    expect(screen.getByText("missingKey")).toBeInTheDocument()
  })

  it("resolves variant from the default map (failed -> destructive)", () => {
    render(<StatusBadge value="failed" labelNamespace="twin.status" data-testid="status" />)
    expect(screen.getByTestId("status").getAttribute("data-variant")).toBe("destructive")
  })

  it("custom variantMap overrides the default map", () => {
    render(
      <StatusBadge
        value="running"
        labelNamespace="twin.status"
        variantMap={{ running: "secondary" }}
        data-testid="status"
      />
    )
    expect(screen.getByTestId("status").getAttribute("data-variant")).toBe("secondary")
  })

  it("uses fallbackVariant when neither map matches", () => {
    render(
      <StatusBadge
        value="totally-unknown"
        labelNamespace="twin.status"
        fallbackVariant="secondary"
        data-testid="status"
      />
    )
    expect(screen.getByTestId("status").getAttribute("data-variant")).toBe("secondary")
  })

  it("renders the pulsing dot when pulse is true", () => {
    const { container } = render(<StatusBadge value="running" labelNamespace="twin.status" pulse />)
    const dot = container.querySelector("span[aria-hidden]")
    expect(dot).toBeTruthy()
    expect(dot?.className).toContain("animate-pulse")
  })

  it("omits the pulsing dot when pulse is false", () => {
    const { container } = render(<StatusBadge value="running" labelNamespace="twin.status" />)
    expect(container.querySelector("span[aria-hidden]")).toBeNull()
  })

  it("wraps in motion.span when motion is allowed", () => {
    render(<StatusBadge value="running" labelNamespace="twin.status" />)
    expect(screen.getByTestId("motion-span")).toBeInTheDocument()
  })

  it("skips the motion wrapper when prefersReducedMotion is true", () => {
    mockUseReducedMotion.mockReturnValueOnce(true)
    render(<StatusBadge value="running" labelNamespace="twin.status" />)
    expect(screen.queryByTestId("motion-span")).not.toBeInTheDocument()
  })

  it("passes className through to the underlying badge", () => {
    render(
      <StatusBadge
        value="running"
        labelNamespace="twin.status"
        className="custom-class"
        data-testid="status"
      />
    )
    expect(screen.getByTestId("status").className).toContain("custom-class")
  })
})
