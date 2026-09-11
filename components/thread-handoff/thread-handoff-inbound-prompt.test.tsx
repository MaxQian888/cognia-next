/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))

import { ThreadHandoffInboundPrompt } from "./thread-handoff-inbound-prompt"

const ticket: import("@cognia/agent-config-types/thread-handoff").ThreadHandoffTicket = {
  ticketVersion: 1,
  ticketId: "ticket-1",
  state: "frozen",
  role: "target",
  source: {
    hostRef: "desktop-1",
    kind: "desktop",
    sessionId: "session-1",
    title: "Planning",
    messageCount: 0,
  },
  target: { hostRef: "phone-1", kind: "mobile" },
  transport: "companion",
  project: {},
  requirements: {
    capabilities: [],
    hostOperations: [],
    providerRefs: [],
    models: [],
    credentialProfileRefs: [],
  },
  continuation: {
    sourceRuntime: "claude-code",
    fidelity: "native-exact",
    sequenceDigest: "digest",
  },
  attachments: [],
  pendingApprovals: [],
  history: [],
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
}
const prepared: import("@/lib/thread-handoff/standalone-receiver").PreparedInboundThreadHandoff = {
  ticket,
  frame: {
    ticket,
    envelope: {
      header: {
        canonicalVersion: 1,
        canonicalSessionId: "session-1",
        sourceRuntime: "claude-code",
        createdAt: "2026-09-10T00:00:00Z",
        updatedAt: "2026-09-10T00:00:00Z",
        turnCount: 0,
        importFidelity: "native-exact",
        sequenceDigest: "digest",
      },
      turns: [],
    },
  },
  preflight: {
    ok: true,
    checkedAt: 1,
    achievableFidelity: "contextual",
    blockers: [
      { kind: "host-operation-missing", ref: "runtime:claude-code", severity: "degraded" },
    ],
  },
}

test("shows the inbound loss and permission-reset disclosure", () => {
  render(
    <ThreadHandoffInboundPrompt prepared={prepared} onAccept={jest.fn()} onDecline={jest.fn()} />
  )
  expect(screen.getByRole("dialog")).toHaveTextContent("permissionReset")
  expect(screen.getByRole("dialog")).toHaveTextContent("fidelityLoss")
  expect(screen.getByRole("button", { name: "accept" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "decline" })).toBeEnabled()
})

test("blocks acceptance when preflight has a blocking reason", () => {
  render(
    <ThreadHandoffInboundPrompt
      prepared={{
        ...prepared,
        preflight: {
          ...prepared.preflight,
          ok: false,
          blockers: [{ kind: "credential-missing", ref: "profile-1", severity: "blocking" }],
        },
      }}
      onAccept={jest.fn()}
      onDecline={jest.fn()}
    />
  )
  expect(screen.getByRole("button", { name: "accept" })).toBeDisabled()
})
