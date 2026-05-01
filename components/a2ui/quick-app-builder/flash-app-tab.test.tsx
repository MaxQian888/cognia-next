/**
 * Tests for FlashAppTab
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FlashAppTab } from "./flash-app-tab"

const mockResolveIcon = jest.fn()

jest.mock("@/lib/a2ui/resolve-icon", () => ({
  resolveIcon: (iconName?: string) => mockResolveIcon(iconName),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    className?: string
  }) => (
    <button type="button" disabled={disabled} className={className} onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    className,
  }: {
    value: string
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
    onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
    placeholder?: string
    className?: string
  }) => (
    <input
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
    />
  ),
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <div data-testid="example-card" className={className} onClick={onClick}>
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

jest.mock("lucide-react", () => ({
  Zap: ({ className }: { className?: string }) => (
    <span data-testid="zap-icon" className={className} />
  ),
  Loader2: ({ className }: { className?: string }) => (
    <span data-testid="loader-icon" className={className} />
  ),
  Send: ({ className }: { className?: string }) => (
    <span data-testid="send-icon" className={className} />
  ),
}))

const ResolvedExampleIcon = ({ className }: { className?: string }) => (
  <span data-testid="resolved-example-icon" className={className} />
)

const getPromptInput = () =>
  screen.getByPlaceholderText("e.g. Make a pomodoro timer...") as HTMLInputElement

const getGenerateButton = (container: HTMLElement) => {
  const button = container.querySelector("button.absolute") as HTMLButtonElement | null
  if (!button) {
    throw new Error("Generate button not found")
  }
  return button
}

describe("FlashAppTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveIcon.mockReturnValue(ResolvedExampleIcon)
  })

  it("disables generate button when input is empty", () => {
    const { container } = render(<FlashAppTab onGenerate={jest.fn()} />)
    expect(getGenerateButton(container)).toBeDisabled()
  })

  it("fills input when suggestion is clicked", () => {
    render(<FlashAppTab onGenerate={jest.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Todo" }))
    expect(getPromptInput().value).toBe("Todo")
  })

  it("fills input with prefixed prompt when example card is clicked", () => {
    render(<FlashAppTab onGenerate={jest.fn()} />)
    fireEvent.click(screen.getAllByTestId("example-card")[0])
    expect(getPromptInput().value).toBe("Make a Calculator")
  })

  it("calls onGenerate and clears input when generate button is clicked", async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined)
    const { container } = render(<FlashAppTab onGenerate={onGenerate} />)

    fireEvent.change(getPromptInput(), { target: { value: "Build a timer app" } })
    fireEvent.click(getGenerateButton(container))

    await waitFor(() => {
      expect(onGenerate).toHaveBeenCalledWith("Build a timer app")
    })
    await waitFor(() => {
      expect(getPromptInput().value).toBe("")
    })
  })

  it("triggers generation when pressing Enter", async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined)
    render(<FlashAppTab onGenerate={onGenerate} />)

    fireEvent.change(getPromptInput(), { target: { value: "Make a dashboard" } })
    fireEvent.keyDown(getPromptInput(), { key: "Enter" })

    await waitFor(() => {
      expect(onGenerate).toHaveBeenCalledWith("Make a dashboard")
    })
  })

  it("does not generate for whitespace-only prompt", () => {
    const onGenerate = jest.fn()
    render(<FlashAppTab onGenerate={onGenerate} />)

    fireEvent.change(getPromptInput(), { target: { value: "   " } })
    fireEvent.keyDown(getPromptInput(), { key: "Enter" })

    expect(onGenerate).not.toHaveBeenCalled()
  })

  it("shows loading icon and disables button while generating", async () => {
    let resolveGenerate: () => void = () => {}
    const onGenerate = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveGenerate = resolve
        })
    )
    const { container } = render(<FlashAppTab onGenerate={onGenerate} />)

    fireEvent.change(getPromptInput(), { target: { value: "Build a tracker" } })
    fireEvent.click(getGenerateButton(container))

    expect(getGenerateButton(container)).toBeDisabled()
    expect(screen.getByTestId("loader-icon")).toBeInTheDocument()

    resolveGenerate()

    await waitFor(() => {
      expect(screen.getByTestId("send-icon")).toBeInTheDocument()
    })
    expect(getGenerateButton(container)).toBeDisabled()
  })
})
