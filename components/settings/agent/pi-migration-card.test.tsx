import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import { PiMigrationCard } from "./pi-migration-card"
import { migrateToPiRpc } from "@/lib/ai/agent/external/pi-migration"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

function legacyAgent(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-pi",
    name: "Pi",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "npx", args: ["-y", "pi-acp"] },
    metadata: { preset: "pi" },
    ...overrides,
  }
}

function renderCard(props: Partial<React.ComponentProps<typeof PiMigrationCard>> = {}) {
  const onApply = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiMigrationCard agent={legacyAgent()} onApply={onApply} {...props} />
    </NextIntlClientProvider>
  )
  return { onApply }
}

describe("PiMigrationCard", () => {
  it("offers the switch for a legacy pi-acp agent", () => {
    renderCard()
    expect(screen.getByTestId("pi-migration-card")).toBeInTheDocument()
    expect(screen.getByTestId("pi-migrate-button")).toBeEnabled()
  })

  /**
   * ADR-0119 never auto-rewrites a config, so the card must be invisible for
   * every agent that is not this specific Pi one — otherwise the settings
   * pane would offer a Pi migration next to a Claude Code agent.
   */
  it("renders nothing for an unrelated agent", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PiMigrationCard
          agent={legacyAgent({ metadata: { preset: "claude-code" }, protocol: "acp" })}
          onApply={jest.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("hands back a migrated config that keeps the agent id", async () => {
    const user = userEvent.setup()
    const { onApply } = renderCard()

    await user.click(screen.getByTestId("pi-migrate-button"))

    expect(onApply).toHaveBeenCalledTimes(1)
    const next = onApply.mock.calls[0][0] as ExternalAgentConfig
    expect(next.id).toBe("agent-pi")
    expect(next.protocol).toBe("pi-rpc")
    expect(next.process).toMatchObject({ command: "pi", args: ["--mode", "rpc"] })
  })

  it("warns that the current conversation does not carry across", () => {
    renderCard()
    // An ACP session id does not map onto a Pi session, so the first native
    // run starts fresh. Users would otherwise read that as data loss.
    expect(screen.getByText(/starts a new Pi session/i)).toBeInTheDocument()
  })

  it("blocks the switch and explains why when the host is not ready", () => {
    renderCard({ blockers: ["sandbox_unavailable", "command_missing"] })

    expect(screen.getByTestId("pi-migrate-button")).toBeDisabled()
    const blockers = screen.getByTestId("pi-migration-blockers")
    expect(blockers).toHaveTextContent(/sandbox is unavailable/i)
    expect(blockers).toHaveTextContent(/not installed/i)
  })

  it("offers rollback once migrated, and returns the original config", async () => {
    const user = userEvent.setup()
    const migrated = migrateToPiRpc(legacyAgent()).config
    const { onApply } = renderCard({ agent: migrated })

    expect(screen.queryByTestId("pi-migrate-button")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("pi-rollback-button"))

    const restored = onApply.mock.calls[0][0] as ExternalAgentConfig
    expect(restored.protocol).toBe("acp")
    expect(restored.process).toMatchObject({ command: "npx", args: ["-y", "pi-acp"] })
    expect(restored.metadata?.piMigration).toBeUndefined()
  })

  it("promises that rollback keeps sessions and transcripts", () => {
    renderCard({ agent: migrateToPiRpc(legacyAgent()).config })
    expect(screen.getByText(/Sessions and transcripts are kept/i)).toBeInTheDocument()
  })
})
