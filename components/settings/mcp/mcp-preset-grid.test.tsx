/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { McpPresetGrid } from "./mcp-preset-grid"

describe("McpPresetGrid", () => {
  it("renders preset cards and filters by search", () => {
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    expect(screen.getByText("Filesystem")).toBeInTheDocument()
    expect(screen.getByText("GitHub")).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "github" } })
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.queryByText("Filesystem")).not.toBeInTheDocument()
  })

  it("drops into the configure step for presets that need fields", () => {
    const onPresetSelected = jest.fn()
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    fireEvent.click(screen.getByText("Filesystem"))
    // Filesystem requires an "Allowed directory" arg, so we land on configure.
    expect(screen.getByTestId("mcp-preset-configure")).toBeInTheDocument()
    // Submit is disabled until the required field is filled.
    const submit = screen.getByText("addServer")
    expect(submit).toBeDisabled()
  })

  it("submits the configure step with entered values", () => {
    const onPresetSelected = jest.fn()
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    fireEvent.click(screen.getByText("Filesystem"))
    const input = screen.getByPlaceholderText("/Users/me/projects")
    fireEvent.change(input, { target: { value: "/tmp" } })
    fireEvent.click(screen.getByText("addServer"))
    expect(onPresetSelected).toHaveBeenCalledTimes(1)
    expect(onPresetSelected.mock.calls[0][1]).toMatchObject({ PATH: "/tmp" })
  })

  it("disables presets whose name is already taken", () => {
    render(<McpPresetGrid existingNames={["github"]} onPresetSelected={jest.fn()} />)
    expect(screen.getByText("GitHub").closest("button")).toBeDisabled()
  })

  it("submits immediately for a field-less preset", () => {
    const onPresetSelected = jest.fn()
    render(<McpPresetGrid existingNames={[]} onPresetSelected={onPresetSelected} />)
    fireEvent.click(screen.getByText("Puppeteer"))
    expect(onPresetSelected).toHaveBeenCalledTimes(1)
    expect(onPresetSelected.mock.calls[0][1]).toEqual({})
    // Stays on the grid (no configure step).
    expect(screen.queryByTestId("mcp-preset-configure")).not.toBeInTheDocument()
  })

  it("returns to the grid from the configure step via Back", () => {
    render(<McpPresetGrid existingNames={[]} onPresetSelected={jest.fn()} />)
    fireEvent.click(screen.getByText("Filesystem"))
    expect(screen.getByTestId("mcp-preset-configure")).toBeInTheDocument()
    fireEvent.click(screen.getByText("back"))
    expect(screen.getByTestId("mcp-preset-grid")).toBeInTheDocument()
  })
})
