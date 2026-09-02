/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"

import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { VerificationVerdictPart } from "./verification-verdict-part"
import compositionMessages from "@/i18n/messages/en/agentComposition.json"
import zhCompositionMessages from "@/i18n/messages/zh-CN/agentComposition.json"
import type { VerificationVerdictPart as VerificationVerdictPartType } from "@/lib/claude/parts-extensions"

// The global next-intl mock resolves keys from the generated aggregate, which
// lags the split sources on dev. This one reads the files the keys are
// authored in, so a new key is testable without regenerating the bundle.
jest.mock("next-intl", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const messages: Record<string, unknown> = {
    agentComposition: require("@/i18n/messages/en/agentComposition.json"),
    agentMode: require("@/i18n/messages/en/agentMode.json"),
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
  const resolve = (root: unknown, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>((cursor, segment) => {
      if (cursor && typeof cursor === "object" && segment in (cursor as object)) {
        return (cursor as Record<string, unknown>)[segment]
      }
      return undefined
    }, root)
  const plural = (template: string, values: Record<string, unknown>): string =>
    template.replace(
      /\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g,
      (_match, name: string, body: string) => {
        const value = Number(values[name])
        const branches = new Map<string, string>()
        const re = /(=\d+|\w+)\s*\{([^{}]*)\}/g
        let m: RegExpExecArray | null
        while ((m = re.exec(body))) branches.set(m[1], m[2])
        const chosen =
          branches.get(`=${value}`) ??
          (value === 1 ? branches.get("one") : undefined) ??
          branches.get("other") ??
          ""
        return chosen.replace(/#/g, String(value))
      }
    )
  const make = (namespace?: string) => {
    const root = namespace ? resolve(messages, namespace) : messages
    const t = (key: string, values: Record<string, unknown> = {}) => {
      const found = resolve(root, key)
      if (typeof found !== "string") return namespace ? `${namespace}.${key}` : key
      return plural(found, values).replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in values ? String(values[name]) : whole
      )
    }
    t.has = (key: string) => typeof resolve(root, key) === "string"
    t.rich = t
    t.raw = (key: string) => resolve(root, key)
    return t
  }
  return {
    useTranslations: make,
    useLocale: () => "en",
    NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  }
})

const setActiveSession = jest.fn()
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => ({ setActiveSession }) },
}))

const getSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const BASE: VerificationVerdictPartType = {
  type: "verification-verdict",
  status: "completed",
  verdict: "fail",
  summary: "The reply claims tests pass but no test file changed.",
  points: ["No test file in the diff", "The reply cites a command that was never run"],
  verificationSessionId: "verifier-1",
  mainSessionId: "main-1",
  diffIncluded: true,
  startedAt: 1,
  completedAt: 2,
}

function renderPart(part: VerificationVerdictPartType) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ agentComposition: compositionMessages }}>
      <VerificationVerdictPart part={part} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  setActiveSession.mockReset()
  getSession.mockReset()
  toastError.mockReset()
})

describe("VerificationVerdictPart", () => {
  it("shows the verdict, the reviewer's sentence and every point", () => {
    renderPart(BASE)
    const card = screen.getByTestId("verification-verdict-part")
    expect(card).toHaveAttribute("data-verdict", "fail")
    expect(screen.getByTestId("verification-verdict-badge")).toHaveTextContent("Did not pass")
    expect(screen.getByTestId("verification-verdict-summary")).toHaveTextContent(
      "no test file changed"
    )
    const points = screen.getByTestId("verification-verdict-points").querySelectorAll("li")
    expect(points).toHaveLength(2)
    expect(card).toHaveTextContent("Checked against the working-tree diff")
  })

  it("labels each verdict and says when there were no points", () => {
    const { rerender } = renderPart({ ...BASE, verdict: "pass", points: [], diffIncluded: false })
    expect(screen.getByTestId("verification-verdict-badge")).toHaveTextContent("Passed")
    expect(screen.getByTestId("verification-verdict-no-points")).toBeInTheDocument()
    expect(screen.getByTestId("verification-verdict-part")).toHaveTextContent(
      "Checked against the reply only"
    )
    rerender(
      <NextIntlClientProvider locale="en" messages={{ agentComposition: compositionMessages }}>
        <VerificationVerdictPart part={{ ...BASE, verdict: "unsure" }} />
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("verification-verdict-badge")).toHaveTextContent("Unsure")
  })

  it("shows a running state without a verdict or an open link", () => {
    renderPart({ ...BASE, status: "running", verdict: undefined, verificationSessionId: "" })
    expect(screen.getByTestId("verification-verdict-running")).toBeInTheDocument()
    expect(screen.queryByTestId("verification-verdict-badge")).not.toBeInTheDocument()
    expect(screen.queryByTestId("verification-verdict-open")).not.toBeInTheDocument()
  })

  it("shows the failure reason when the reviewer could not run", () => {
    renderPart({ ...BASE, status: "failed", verdict: undefined, error: "sidecar offline" })
    expect(screen.getByTestId("verification-verdict-failed")).toBeInTheDocument()
    expect(screen.getByTestId("verification-verdict-error")).toHaveTextContent("sidecar offline")
    expect(screen.queryByTestId("verification-verdict-points")).not.toBeInTheDocument()
  })

  it("opens the reviewer session when it exists on this device", async () => {
    getSession.mockResolvedValue({ id: "verifier-1" })
    renderPart(BASE)
    await userEvent.click(screen.getByTestId("verification-verdict-open"))
    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith("verifier-1"))
    expect(toastError).not.toHaveBeenCalled()
  })

  it("explains a missing reviewer session instead of opening an empty pane", async () => {
    getSession.mockResolvedValue(undefined)
    renderPart(BASE)
    await userEvent.click(screen.getByTestId("verification-verdict-open"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The reviewer session is not on this device.")
    )
    expect(setActiveSession).not.toHaveBeenCalled()
  })

  it("has every verdict label in both languages", () => {
    for (const verdict of ["pass", "fail", "unsure"]) {
      expect(compositionMessages.verification.verdict).toHaveProperty(verdict)
      expect(zhCompositionMessages.verification.verdict).toHaveProperty(verdict)
    }
    expect(Object.keys(zhCompositionMessages.verification).sort()).toEqual(
      Object.keys(compositionMessages.verification).sort()
    )
  })
})
