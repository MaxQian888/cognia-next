/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const registerPairPayload = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
jest.mock("@/components/mobile/pair/pair-api", () => ({
  registerPairPayload: (...args: unknown[]) => registerPairPayload(...args),
}))

import type { AuthFetcher } from "@/lib/tauri/companion-auth"
import { __resetRoutingForTests, getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  __setRemoteTransportFactoryForTests,
  useRemoteHostStore,
} from "@/stores/remote-host/remote-host-store"
import { AddHostTab } from "./add-host-tab"

const fakeRemote: Transport = {
  call: (async () => undefined) as Transport["call"],
  subscribe: () => () => {},
}

const fetcher = jest.fn() as AuthFetcher
const payload = "cgnp3|eyJiYXNlVXJsIjoiaHR0cHM6Ly9ib3guZXhhbXBsZSJ9"
const pairedConfig = {
  baseUrl: "https://box.example:27890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
  deviceKeyThumbprint: "device-thumbprint",
  deviceId: "remote-1",
  serverVersion: "1.0.0",
}

beforeEach(() => {
  jest.clearAllMocks()
  registerPairPayload.mockResolvedValue({ kind: "ok", config: pairedConfig })
  useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  __resetRoutingForTests()
  __setRemoteTransportFactoryForTests(() => fakeRemote)
})

afterEach(() => {
  __setRemoteTransportFactoryForTests(null)
  __resetRoutingForTests()
})

it("registers a cgnp3 invitation, adds the returned device identity, and connects", async () => {
  const user = userEvent.setup()
  const onPaired = jest.fn()
  render(<AddHostTab onPaired={onPaired} fetcher={fetcher} />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), `  ${payload}  `)
  await user.type(screen.getByLabelText("settings.remoteHosts.add.labelLabel"), "  Dev box  ")
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  await waitFor(() => expect(useRemoteHostStore.getState().hosts).toHaveLength(1))
  expect(registerPairPayload).toHaveBeenCalledWith(payload, fetcher)
  const host = useRemoteHostStore.getState().hosts[0]
  expect(host).toMatchObject({ label: "Dev box", config: pairedConfig })
  expect(useRemoteHostStore.getState().activeHostId).toBe(host.id)
  expect(getActiveRemoteTransport()).toBe(fakeRemote)
  expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ id: host.id, label: "Dev box" }))
  expect(screen.getByRole("status")).toHaveTextContent("settings.remoteHosts.add.success")
})

it("does not expose a separate base URL field because the invitation owns the origin", () => {
  render(<AddHostTab />)
  expect(screen.queryByLabelText("settings.remoteHosts.add.baseUrlLabel")).toBeNull()
})

it("does not activate when connect-after is turned off", async () => {
  const user = userEvent.setup()
  render(<AddHostTab />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), payload)
  await user.click(screen.getByRole("switch"))
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  await waitFor(() => expect(useRemoteHostStore.getState().hosts).toHaveLength(1))
  expect(useRemoteHostStore.getState().activeHostId).toBeNull()
  expect(getActiveRemoteTransport()).toBeNull()
})

it("shows an error when no invitation is pasted", async () => {
  const user = userEvent.setup()
  render(<AddHostTab />)

  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errMissing")
  expect(registerPairPayload).not.toHaveBeenCalled()
})

it("maps an invalid cgnp3 payload to the payload-specific error", async () => {
  const user = userEvent.setup()
  registerPairPayload.mockResolvedValue({ kind: "invalid_payload", message: "invalid" })
  render(<AddHostTab />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "not a payload")
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errPayload")
  expect(useRemoteHostStore.getState().hosts).toHaveLength(0)
})

it("maps registration failures to a non-sensitive generic error", async () => {
  const user = userEvent.setup()
  registerPairPayload.mockResolvedValue({ kind: "registration_error", message: "proof rejected" })
  render(<AddHostTab />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), payload)
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errGeneric")
  expect(screen.getByRole("alert")).not.toHaveTextContent("proof rejected")
})
