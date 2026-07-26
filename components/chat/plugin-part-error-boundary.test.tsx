/**
 * @jest-environment jsdom
 */
jest.mock("@cognia/logging", () => ({
  loggers: { chat: { warn: jest.fn() } },
}))

import React from "react"
import { render, screen } from "@testing-library/react"
import { loggers } from "@cognia/logging"
import PluginPartErrorBoundaryDefault, {
  PluginPartErrorBoundary,
} from "./plugin-part-error-boundary"

const warnMock = loggers.chat.warn as jest.Mock

// React logs caught render errors to console.error; silence it so the test
// output stays readable. Restored after each test.
let consoleErrorSpy: jest.SpyInstance
beforeEach(() => {
  warnMock.mockClear()
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleErrorSpy.mockRestore()
})

function Boom(): React.JSX.Element {
  throw new Error("kaboom")
}

describe("PluginPartErrorBoundary", () => {
  it("renders children untouched when nothing throws", () => {
    render(
      <PluginPartErrorBoundary type="weather-card" pluginId="acme.weather">
        <span data-testid="ok">healthy</span>
      </PluginPartErrorBoundary>
    )
    expect(screen.getByTestId("ok")).toHaveTextContent("healthy")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(warnMock).not.toHaveBeenCalled()
  })

  it("degrades a throwing plugin renderer to an inline diagnostic naming the part type", () => {
    render(
      <PluginPartErrorBoundary type="weather-card" pluginId="acme.weather">
        <Boom />
      </PluginPartErrorBoundary>
    )
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent('Plugin renderer for "weather-card" crashed: kaboom')
    expect(alert).toHaveAttribute("data-plugin-id", "acme.weather")
    expect(alert).toHaveAttribute("data-part-type", "weather-card")
  })

  it("keeps the surrounding message mounted when the plugin subtree throws", () => {
    render(
      <div>
        <span data-testid="sibling">rest of the message</span>
        <PluginPartErrorBoundary type="weather-card" pluginId="acme.weather">
          <Boom />
        </PluginPartErrorBoundary>
      </div>
    )
    expect(screen.getByTestId("sibling")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("logs a message-part crash by default", () => {
    render(
      <PluginPartErrorBoundary type="weather-card" pluginId="acme.weather">
        <Boom />
      </PluginPartErrorBoundary>
    )
    expect(warnMock).toHaveBeenCalledWith("plugin message-part renderer threw", {
      pluginId: "acme.weather",
      partType: "weather-card",
      err: "kaboom",
    })
  })

  it("distinguishes a tool-result crash in the log line", () => {
    render(
      <PluginPartErrorBoundary type="get_forecast" pluginId="acme.weather" kind="tool-result">
        <Boom />
      </PluginPartErrorBoundary>
    )
    expect(warnMock).toHaveBeenCalledWith("plugin tool-result renderer threw", {
      pluginId: "acme.weather",
      partType: "get_forecast",
      err: "kaboom",
    })
  })

  it("is also reachable as the default export", () => {
    expect(PluginPartErrorBoundaryDefault).toBe(PluginPartErrorBoundary)
  })
})
