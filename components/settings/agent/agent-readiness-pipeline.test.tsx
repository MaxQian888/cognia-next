/**
 * AgentReadinessPipeline / AgentReadinessDots / AgentStatePill —
 * pure render tests over fabricated readiness states.
 */

import { render, screen } from "@testing-library/react"
import {
  AgentReadinessDots,
  AgentReadinessPipeline,
  AgentStatePill,
} from "./agent-readiness-pipeline"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import externalAgentMessages from "@/i18n/messages/en/externalAgent.json"

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  useLocale: () => "en",
  useTranslations: (namespace: string) => {
    const [root, ...path] = namespace.split(".")
    const source = jest.requireActual(`@/i18n/messages/en/${root}.json`)
    const lookup = (key: string): unknown =>
      [...path, ...key.split(".")].reduce((value, part) => value?.[part], source)
    const translate = (key: string, values: Record<string, unknown> = {}) => {
      const message = lookup(key)
      if (typeof message !== "string")
        throw new Error(`Missing split-source message: ${namespace}.${key}`)
      return message
        .replace(
          /\{(\w+),\s*plural,\s*((?:(?:=\d+|\w+)\s*\{(?:[^{}]|\{\w+\})*\}\s*)+)\}/g,
          (_, name, body) => {
            const branches = Object.fromEntries(
              [...body.matchAll(/(=\d+|\w+)\s*\{((?:[^{}]|\{\w+\})*)\}/g)].map(
                (match: RegExpMatchArray) => [match[1], match[2]]
              )
            )
            return (
              branches[`=${values[name]}`] ??
              branches[new Intl.PluralRules("en").select(Number(values[name]))] ??
              branches.other
            ).replace(/#/g, String(values[name]))
          }
        )
        .replace(/\{(\w+)(?:,\s*number)?\}/g, (_, name) => String(values[name] ?? `{${name}}`))
    }
    translate.has = (key: string) => typeof lookup(key) === "string"
    translate.raw = lookup
    translate.rich = translate
    return translate
  },
}))

const fullyReady: AgentReadiness = {
  state: "connected",
  ready: true,
  blockReason: null,
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "done" },
    { id: "connected", state: "done" },
    { id: "routed", state: "done", optional: true },
  ],
  nextAction: null,
}

const blocked: AgentReadiness = {
  state: "blocked",
  ready: false,
  blockReason: "runtime not installed",
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "failed" },
    { id: "connected", state: "todo" },
    { id: "routed", state: "todo", optional: true },
  ],
  nextAction: "inspect",
}

describe("AgentReadinessPipeline", () => {
  it("renders every step with its state encoded in the testid", () => {
    render(<AgentReadinessPipeline readiness={blocked} />)
    expect(screen.getByTestId("step-configured-done")).toBeInTheDocument()
    expect(screen.getByTestId("step-runnable-failed")).toBeInTheDocument()
    expect(screen.getByTestId("step-connected-todo")).toBeInTheDocument()
    expect(screen.getByTestId("step-routed-todo")).toBeInTheDocument()
    // Full density carries the step labels.
    expect(screen.getByText("Runnable")).toBeInTheDocument()
  })

  it("compact mode drops visible labels but keeps the step markers", () => {
    render(<AgentReadinessPipeline readiness={fullyReady} compact />)
    expect(screen.getAllByTestId(/^step-.*-done$/)).toHaveLength(4)
    // Every visible label is gone; what remains is screen-reader-only text.
    for (const node of screen.getAllByText(/^Connected:/)) {
      expect(node).toHaveClass("sr-only")
    }
  })

  it("wraps the full pipeline and announces every step state", () => {
    render(<AgentReadinessPipeline readiness={blocked} />)
    expect(screen.getByRole("list")).toHaveClass("flex-wrap", "gap-y-2")
    screen.getAllByRole("listitem").forEach((item, index) => {
      const state = blocked.steps[index].state
      expect(item.querySelector(".sr-only")).toHaveTextContent(
        externalAgentMessages.readiness.stepStates[state]
      )
    })
  })

  it("identifies routing as optional with a dashed connector", () => {
    render(<AgentReadinessPipeline readiness={blocked} />)
    const routed = screen.getByTestId("step-routed-todo").closest("li")!
    expect(routed).toHaveTextContent(externalAgentMessages.readiness.optional)
    expect(routed.querySelector(".border-dashed")).toBeInTheDocument()
    expect(
      screen.getByTestId("step-connected-todo").closest("li")!.querySelector(".border-dashed")
    ).not.toBeInTheDocument()
  })

  it("compact mode still names each step and its state to a screen reader", () => {
    render(<AgentReadinessPipeline readiness={blocked} compact />)
    const items = screen.getAllByRole("listitem").map((item) => item.textContent)
    expect(items).toHaveLength(4)
    expect(items[1]).toContain("Runnable")
    expect(items.every((text) => Boolean(text?.trim()))).toBe(true)
    expect(items[3]).toContain(externalAgentMessages.readiness.optional)
    expect(items[3]).toContain(externalAgentMessages.readiness.stepStates.todo)
  })
})

describe("AgentReadinessDots", () => {
  it("renders one dot per step with an accessible summary", () => {
    render(<AgentReadinessDots readiness={blocked} />)
    expect(screen.getByTestId("dot-runnable-failed")).toBeInTheDocument()
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Runnable")
  })
})

describe("AgentStatePill", () => {
  it("labels each state from the i18n map", () => {
    render(<AgentStatePill readiness={fullyReady} />)
    expect(screen.getByTestId("agent-state-connected")).toHaveTextContent("Connected")
  })

  it("renders a transient block as checking, not settled failure", () => {
    render(<AgentStatePill readiness={{ ...blocked, blockTransient: true }} />)
    expect(screen.getByTestId("agent-state-blocked")).toHaveTextContent("Checking")
  })
})
