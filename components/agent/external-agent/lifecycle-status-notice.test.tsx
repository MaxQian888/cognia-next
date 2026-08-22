import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import externalAgentEn from "@/i18n/messages/en/externalAgent.json"
import externalAgentZh from "@/i18n/messages/zh-CN/externalAgent.json"
import {
  EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES,
  EXTERNAL_AGENT_LIFECYCLE_STATUSES,
} from "@/types/agent/external-agent-lifecycle"
import { lifecycleErrorKey } from "@/lib/ai/agent/external/lifecycle/error-messages"

import { LifecycleStatusNotice, type LifecycleStatusNoticeProps } from "./lifecycle-status-notice"

function renderNotice(props: LifecycleStatusNoticeProps) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ externalAgent: externalAgentEn }}>
      <LifecycleStatusNotice {...props} />
    </NextIntlClientProvider>
  )
}

describe("LifecycleStatusNotice", () => {
  it("renders nothing for a ready agent", () => {
    const { container } = renderNotice({ status: "ready", reasonCode: "runtime_missing" })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when no verdict has been recorded yet", () => {
    const { container } = renderNotice({})
    expect(container).toBeEmptyDOMElement()
  })

  it("explains a blocked agent in the user's language, not the developer's", () => {
    renderNotice({ status: "blocked", reasonCode: "adapter_unavailable" })

    expect(screen.getByTestId("lifecycle-status-notice")).toHaveAttribute("data-status", "blocked")
    expect(screen.getByText("Cannot start")).toBeInTheDocument()
    expect(
      screen.getByText("The plugin that provides this agent's protocol is not enabled.")
    ).toBeInTheDocument()
  })

  it("labels each non-ready status distinctly", () => {
    for (const status of ["needs-credentials", "needs-consent", "needs-runtime"] as const) {
      const { unmount } = renderNotice({ status, reasonCode: "runtime_missing" })
      expect(screen.getByTestId("lifecycle-status-notice")).toHaveAttribute("data-status", status)
      unmount()
    }
  })

  it("says the reason is missing rather than implying the agent is fine", () => {
    // A verdict always carries a code; an absent one is a writer defect, and
    // rendering nothing would read as "no problem".
    renderNotice({ status: "blocked" })
    expect(
      screen.getByText("Cognia stopped this agent and did not record why. Re-check its settings.")
    ).toBeInTheDocument()
  })

  it("renders the caller's action next to the reason", () => {
    renderNotice({
      status: "needs-consent",
      reasonCode: "consent_required",
      action: <button type="button">Review</button>,
    })
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument()
  })
})

describe("message coverage", () => {
  // Both lookups use template keys, which `lint:i18n` cannot see: a status or
  // an error code added to its union without strings would render the raw key
  // path to the user.
  it.each(["en", "zh-CN"])("%s covers every status and every reason code", (locale) => {
    const messages = (locale === "en" ? externalAgentEn : externalAgentZh) as unknown as {
      lifecycle: { statusLabel: Record<string, string>; noReason: string }
      lifecycleErrors: Record<string, string>
    }

    const camel = (value: string) =>
      value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

    const missing: string[] = []
    for (const status of EXTERNAL_AGENT_LIFECYCLE_STATUSES) {
      if (status === "ready") continue
      if (!messages.lifecycle.statusLabel[camel(status)]) {
        missing.push(`lifecycle.statusLabel.${camel(status)}`)
      }
    }
    for (const code of EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES) {
      const key = lifecycleErrorKey(code)
      if (!messages.lifecycleErrors[key]) missing.push(`lifecycleErrors.${key}`)
    }
    if (!messages.lifecycle.noReason) missing.push("lifecycle.noReason")

    expect(missing).toEqual([])
  })
})
