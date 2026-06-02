/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { WorkspaceTrustGate } from "./workspace-trust-gate"

const trustAll = jest.fn().mockResolvedValue(undefined)
let mockState = {
  restricted: false,
  untrustedRoots: [] as { id: string; path: string }[],
  trustState: {},
  trustRoot: jest.fn(),
  trustAll,
}

jest.mock("@/hooks/workspace/use-workspace-trust", () => ({
  useWorkspaceTrust: () => mockState,
}))

function renderGate(props: Partial<React.ComponentProps<typeof WorkspaceTrustGate>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkspaceTrustGate sessionId="s1" promptNonce={0} {...props} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  trustAll.mockClear()
  mockState = {
    restricted: false,
    untrustedRoots: [],
    trustState: {},
    trustRoot: jest.fn(),
    trustAll,
  }
})

it("renders no banner when not restricted", () => {
  renderGate()
  expect(screen.queryByText(en.chat.workspaceRestricted.title)).not.toBeInTheDocument()
})

it("renders the banner when restricted", () => {
  mockState.restricted = true
  mockState.untrustedRoots = [{ id: "r", path: "/a" }]
  renderGate()
  expect(screen.getByText(en.chat.workspaceRestricted.title)).toBeInTheDocument()
})

it("opens the trust dialog when promptNonce increments while restricted", () => {
  mockState.restricted = true
  mockState.untrustedRoots = [{ id: "r", path: "/a" }]
  const { rerender } = renderGate({ promptNonce: 0 })
  expect(screen.queryByText(en.chat.workspaceTrust.title)).not.toBeInTheDocument()
  rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkspaceTrustGate sessionId="s1" promptNonce={1} />
    </NextIntlClientProvider>
  )
  expect(screen.getByText(en.chat.workspaceTrust.title)).toBeInTheDocument()
})

it("does not open the dialog on prompt when not restricted", () => {
  const { rerender } = renderGate({ promptNonce: 0 })
  rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkspaceTrustGate sessionId="s1" promptNonce={1} />
    </NextIntlClientProvider>
  )
  expect(screen.queryByText(en.chat.workspaceTrust.title)).not.toBeInTheDocument()
})

it("trusts the workspace from the banner button", async () => {
  mockState.restricted = true
  mockState.untrustedRoots = [{ id: "r", path: "/a" }]
  renderGate()
  fireEvent.click(screen.getByRole("button", { name: en.chat.workspaceRestricted.trust }))
  await waitFor(() => expect(trustAll).toHaveBeenCalled())
})
