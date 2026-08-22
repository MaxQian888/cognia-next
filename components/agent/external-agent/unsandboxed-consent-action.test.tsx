import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import externalAgentEn from "@/i18n/messages/en/externalAgent.json"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

import { UnsandboxedConsentAction } from "./unsandboxed-consent-action"

const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: { error: (message: string) => toastError(message) },
}))

function agent(overrides: Partial<LifecycleExternalAgentConfig> = {}) {
  return {
    id: "agent-1",
    name: "My Codex",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
    runtimeBinding: {
      runtimeId: "codex-acp",
      ownership: "system",
      resolvedExecutablePath: "C:\\tools\\npx.cmd",
      pinnedVersion: "0.5.0",
    },
    ...overrides,
  } as unknown as LifecycleExternalAgentConfig
}

function renderAction(props: Partial<Parameters<typeof UnsandboxedConsentAction>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ externalAgent: externalAgentEn }}>
      <UnsandboxedConsentAction
        agent={agent()}
        refreshRuntime={async () => undefined}
        grantConsent={async () => undefined}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  toastError.mockClear()
})

describe("UnsandboxedConsentAction", () => {
  it("renders nothing for an agent bound to no runtime", () => {
    const { container } = renderAction({ agent: agent({ runtimeBinding: undefined }) })
    expect(container).toBeEmptyDOMElement()
  })

  it("re-checks the runtime before showing what would run", async () => {
    // The approval is compared against the binding on every later launch, and
    // the binding only carries a digest and a version once a probe wrote them.
    const refreshRuntime = jest.fn(async () => undefined)
    renderAction({ refreshRuntime })

    await userEvent.click(screen.getByTestId("unsandboxed-consent-open"))

    expect(refreshRuntime).toHaveBeenCalledWith("codex-acp")
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("still opens when the host cannot probe", async () => {
    // A host with no probe can still approve what the configuration says would
    // run — which is exactly what the check compares against.
    const refreshRuntime = jest.fn(async () => {
      throw new ExternalAgentLifecycleError("platform_unsupported", "no host")
    })
    renderAction({ refreshRuntime })

    await userEvent.click(screen.getByTestId("unsandboxed-consent-open"))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("shows the resolved executable and version, not the bare command", async () => {
    renderAction()
    await userEvent.click(screen.getByTestId("unsandboxed-consent-open"))

    expect(await screen.findByText("C:\\tools\\npx.cmd")).toBeInTheDocument()
    expect(screen.getByText("0.5.0")).toBeInTheDocument()
  })

  it("falls back to the configured command when nothing has been resolved yet", async () => {
    renderAction({
      agent: agent({
        runtimeBinding: { runtimeId: "codex-acp", ownership: "system" },
      }),
    })
    await userEvent.click(screen.getByTestId("unsandboxed-consent-open"))

    expect(await screen.findByText("npx")).toBeInTheDocument()
  })

  it("grants by agent id, never by a caller-assembled identity", async () => {
    const grantConsent = jest.fn(async () => undefined)
    renderAction({ grantConsent })

    await userEvent.click(screen.getByTestId("unsandboxed-consent-open"))
    await screen.findByRole("dialog")
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: /run without the sandbox/i }))

    await waitFor(() => expect(grantConsent).toHaveBeenCalledWith("agent-1"))
    // Exactly one argument: the service owns what the approval describes.
    expect(grantConsent.mock.calls[0]).toHaveLength(1)
  })

  it("keeps the dialog open and explains a refused grant", async () => {
    const grantConsent = jest.fn(async () => {
      throw new ExternalAgentLifecycleError("platform_unsupported", "not windows")
    })
    renderAction({ grantConsent })

    await userEvent.click(screen.getByTestId("unsandboxed-consent-open"))
    await screen.findByRole("dialog")
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(screen.getByRole("button", { name: /run without the sandbox/i }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("This agent cannot run on this device.")
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
