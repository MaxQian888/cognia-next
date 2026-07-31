import { render, screen } from "@testing-library/react"
import { Toaster, toast } from "./sonner"

jest.mock("sonner", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react")
  return {
    Toaster: ({ theme, className }: { theme?: string; className?: string }) =>
      React.createElement("div", {
        "data-testid": "sonner-toaster",
        "data-sonner-theme": theme,
        className,
      }),
    toast: {
      success: jest.fn(),
      dismiss: jest.fn(),
    },
  }
})

describe("Sonner", () => {
  it("exports the themed toaster and toast dispatcher", () => {
    render(<Toaster theme="dark" />)

    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-sonner-theme", "dark")
    expect(screen.getByTestId("sonner-toaster")).toHaveClass("toaster", "group")
    expect(typeof toast.success).toBe("function")
  })
})
