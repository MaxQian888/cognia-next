/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import { detectTrigger } from "../composer-trigger"
import { CommandHintBar, resolveCommandHint } from "./command-hint-bar"

const review: SlashCommand = {
  name: "review",
  description: "Review a diff",
  scope: "builtin",
  argumentHint: "<path>",
  template: "review $ARGUMENTS",
}
const clear: SlashCommand = {
  name: "clear",
  description: "Start a new session",
  scope: "builtin",
  handler: jest.fn(),
}
const commandMap = new Map<string, SlashCommand>([
  ["review", review],
  ["clear", clear],
])

const hintFor = (value: string, caret = value.length) =>
  resolveCommandHint(detectTrigger(value, caret), commandMap, value)

describe("resolveCommandHint", () => {
  it("returns null while the command NAME is still being typed", () => {
    expect(hintFor("/rev")).toBeNull()
  })

  it("returns null for a non-slash trigger", () => {
    expect(hintFor("see @lib/db")).toBeNull()
  })

  it("returns null with no trigger at all", () => {
    expect(resolveCommandHint(null, commandMap, "")).toBeNull()
  })

  it("returns null for an unknown command", () => {
    expect(hintFor("/nope ")).toBeNull()
  })

  it("resolves the command once the caret enters the argument region", () => {
    expect(hintFor("/review ")?.command.name).toBe("review")
  })

  it("flags missing arguments for a command that declares an argumentHint", () => {
    expect(hintFor("/review ")?.missingParams).toBe(true)
  })

  it("clears the missing-arguments flag once an argument is typed", () => {
    expect(hintFor("/review src/a.ts")?.missingParams).toBe(false)
  })

  it("does not flag a command that takes no arguments", () => {
    expect(hintFor("/clear ")?.missingParams).toBe(false)
  })
})

describe("CommandHintBar", () => {
  const renderFor = (value: string) =>
    render(
      <CommandHintBar
        trigger={detectTrigger(value, value.length)}
        commandMap={commandMap}
        value={value}
      />
    )

  it("renders nothing when no command is being argued", () => {
    const { container } = renderFor("/rev")
    expect(container.firstChild).toBeNull()
  })

  it("shows the command name, argument hint and description", () => {
    renderFor("/review ")
    const bar = screen.getByTestId("command-hint-bar")
    expect(bar).toHaveTextContent("/review")
    expect(bar).toHaveTextContent("<path>")
    expect(bar).toHaveTextContent("Review a diff")
  })

  it("shows the needs-arguments note only while arguments are missing", () => {
    const { unmount } = renderFor("/review ")
    expect(screen.getByTestId("command-hint-bar")).toHaveTextContent("needsArgs")
    unmount()
    renderFor("/review src/a.ts")
    expect(screen.getByTestId("command-hint-bar")).not.toHaveTextContent("needsArgs")
  })
})
