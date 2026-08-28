/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))

import { ThreadHandoffInboundPrompt } from "./thread-handoff-inbound-prompt"

const prepared = {
  ticket: {
    source: { title: "Planning" },
    continuation: { fidelity: "native-exact" },
  },
  preflight: {
    ok: true,
    achievableFidelity: "contextual",
    blockers: [
      {
        kind: "host-operation-missing",
        ref: "runtime:claude-code",
        severity: "degraded",
      },
    ],
  },
} as never

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
