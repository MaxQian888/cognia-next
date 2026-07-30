/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
jest.mock("@/lib/signaling/v2-crypto", () => ({
  generatePersistableV2SigningIdentity: async () => ({
    privateKey: {},
    publicKey: {},
    privateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    encodedPublicKey: "mobile-signing-key",
  }),
  buildRoomDescriptorV2: async (input: Record<string, unknown>) => ({
    v: 2,
    roomId: "room-1",
    ...input,
  }),
  importV2SigningPrivateKey: async () => ({}),
}))

import type { PairFetcher } from "@/components/mobile/pair/pair-api"
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

function okFetcher(body: Record<string, unknown>): PairFetcher {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response
}

const networkFetcher: PairFetcher = async () => {
  throw new Error("Failed to fetch")
}

function errorFetcher(status: number, text: string): PairFetcher {
  return async () =>
    ({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => text,
    }) as unknown as Response
}

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const PAIR_BODY = {
  deviceJwt: "dev.jwt.sig",
  deviceId: "remote-1",
  serverVersion: "1.0.0",
  rendezvousId: "room-1",
  roomDescriptor: {
    v: 2 as const,
    roomId: "room-1",
    roomNonce: "room-nonce",
    desktopSigningKey: "desktop-signing-key",
    mobileSigningKey: "mobile-signing-key",
    notAfter: Date.now() + 60_000,
  },
}

beforeEach(() => {
  useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  __resetRoutingForTests()
  __setRemoteTransportFactoryForTests(() => fakeRemote)
})
afterEach(() => {
  __setRemoteTransportFactoryForTests(null)
  __resetRoutingForTests()
})

it("pairs from a raw JWT + base URL, registers the host, and connects", async () => {
  const user = userEvent.setup()
  const onPaired = jest.fn()
  render(<AddHostTab onPaired={onPaired} fetcher={okFetcher(PAIR_BODY)} />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "aaa.bbb.ccc")
  await user.type(
    screen.getByLabelText("settings.remoteHosts.add.baseUrlLabel"),
    "https://box.example:27890"
  )
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  await waitFor(() => expect(useRemoteHostStore.getState().hosts).toHaveLength(1))
  const host = useRemoteHostStore.getState().hosts[0]
  expect(host.config.baseUrl).toBe("https://box.example:27890")
  expect(host.config.deviceJwt).toBe("dev.jwt.sig")
  // connectAfter defaults on → activated.
  expect(useRemoteHostStore.getState().activeHostId).toBe(host.id)
  expect(getActiveRemoteTransport()).not.toBeNull()
  expect(onPaired).toHaveBeenCalledTimes(1)
  expect(onPaired.mock.calls[0][0].id).toBe(host.id)
})

it("derives the base URL from a pasted cgnp2 payload", async () => {
  const user = userEvent.setup()
  const payload =
    "cgnp2|" +
    base64url(
      JSON.stringify({ baseUrl: "https://derived.example:27890", pairJwt: "x.y.z", fp: "ab12" })
    )
  render(<AddHostTab fetcher={okFetcher(PAIR_BODY)} />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), payload)
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  await waitFor(() => expect(useRemoteHostStore.getState().hosts).toHaveLength(1))
  expect(useRemoteHostStore.getState().hosts[0].config.baseUrl).toBe(
    "https://derived.example:27890"
  )
})

it("does not activate when connect-after is turned off", async () => {
  const user = userEvent.setup()
  render(<AddHostTab fetcher={okFetcher(PAIR_BODY)} />)

  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "aaa.bbb.ccc")
  await user.type(
    screen.getByLabelText("settings.remoteHosts.add.baseUrlLabel"),
    "https://box.example:27890"
  )
  await user.click(screen.getByRole("switch"))
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))

  await waitFor(() => expect(useRemoteHostStore.getState().hosts).toHaveLength(1))
  expect(useRemoteHostStore.getState().activeHostId).toBeNull()
})

it("shows an error when nothing is pasted", async () => {
  const user = userEvent.setup()
  render(<AddHostTab fetcher={okFetcher(PAIR_BODY)} />)
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errMissing")
  expect(useRemoteHostStore.getState().hosts).toHaveLength(0)
})

it("requires a base URL for a raw JWT", async () => {
  const user = userEvent.setup()
  render(<AddHostTab fetcher={okFetcher(PAIR_BODY)} />)
  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "aaa.bbb.ccc")
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errBaseUrl")
})

it("surfaces a network error", async () => {
  const user = userEvent.setup()
  render(<AddHostTab fetcher={networkFetcher} />)
  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "aaa.bbb.ccc")
  await user.type(
    screen.getByLabelText("settings.remoteHosts.add.baseUrlLabel"),
    "https://box.example:27890"
  )
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errNetwork")
})

it("rejects text that is neither a payload nor a JWT", async () => {
  const user = userEvent.setup()
  render(<AddHostTab fetcher={okFetcher(PAIR_BODY)} />)
  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "not a token")
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errPayload")
  expect(useRemoteHostStore.getState().hosts).toHaveLength(0)
})

it("surfaces an HTTP error from the host", async () => {
  const user = userEvent.setup()
  render(<AddHostTab fetcher={errorFetcher(401, "unauthorized")} />)
  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "aaa.bbb.ccc")
  await user.type(
    screen.getByLabelText("settings.remoteHosts.add.baseUrlLabel"),
    "https://box.example:27890"
  )
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errHttp")
})

it("maps a structured pair-code error to the generic message", async () => {
  const user = userEvent.setup()
  render(
    <AddHostTab
      fetcher={errorFetcher(400, JSON.stringify({ code: "pair_code_expired", message: "expired" }))}
    />
  )
  await user.type(screen.getByLabelText("settings.remoteHosts.add.payloadLabel"), "aaa.bbb.ccc")
  await user.type(
    screen.getByLabelText("settings.remoteHosts.add.baseUrlLabel"),
    "https://box.example:27890"
  )
  await user.click(screen.getByRole("button", { name: "settings.remoteHosts.add.submit" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("settings.remoteHosts.add.errGeneric")
})
