jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))

import { act, fireEvent, render, screen } from "@testing-library/react"

import { STATUS_PAGE_URL } from "@/lib/constants/external-urls"
import { openExternal } from "@/lib/tauri/opener"

import {
  isOfficialSignalingUrl,
  signalingHost,
  StatusPageLinkBlock,
} from "./status-page-link-block"

const openExternalMock = openExternal as jest.Mock

beforeEach(() => {
  openExternalMock.mockReset()
  openExternalMock.mockResolvedValue(undefined)
})

describe("isOfficialSignalingUrl", () => {
  it("matches the official host over a secure scheme only", () => {
    expect(isOfficialSignalingUrl("wss://signaling.cognia.cn/signaling")).toBe(true)
    expect(isOfficialSignalingUrl("wss://SIGNALING.cognia.cn/signaling/")).toBe(true)
    expect(isOfficialSignalingUrl("ws://signaling.cognia.cn/signaling")).toBe(false)
    expect(isOfficialSignalingUrl("wss://signaling.cognia.cn:8443/signaling")).toBe(false)
    expect(isOfficialSignalingUrl("wss://relay.example.com/signaling")).toBe(false)
    expect(isOfficialSignalingUrl("wss://signaling.cognia.cn.evil.example/signaling")).toBe(false)
    expect(isOfficialSignalingUrl("not a url")).toBe(false)
  })

  it("extracts the host for the label", () => {
    expect(signalingHost("wss://relay.example.com/signaling")).toBe("relay.example.com")
    expect(signalingHost("nope")).toBeNull()
  })
})

describe("StatusPageLinkBlock", () => {
  it("opens the official status page through the cross-platform opener", async () => {
    render(<StatusPageLinkBlock signalingUrl="wss://signaling.cognia.cn/signaling" />)
    expect(screen.getByTestId("status-page-scope")).toHaveAttribute("data-official", "true")
    expect(screen.getByTestId("status-page-scope")).toHaveTextContent("Official relay")
    expect(screen.getByTestId("status-page-scope-note")).toHaveTextContent(
      "This device uses the official hosted relay"
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open public status page" }))
    })
    expect(openExternalMock).toHaveBeenCalledWith(STATUS_PAGE_URL)
  })

  it("says the public page does not describe a self-hosted relay and shows no official status", () => {
    render(<StatusPageLinkBlock signalingUrl="wss://relay.example.com/signaling" />)
    const scope = screen.getByTestId("status-page-scope")
    expect(scope).toHaveAttribute("data-official", "false")
    expect(scope).toHaveTextContent("Not covered")
    expect(screen.getByTestId("status-page-scope-note")).toHaveTextContent(
      "describes only the official hosted relay, not this one"
    )
    expect(screen.getByTestId("status-page-scope-note")).toHaveTextContent("relay.example.com")
    expect(screen.queryByText(/This device uses the official hosted relay/)).toBeNull()
    expect(screen.queryByText("Official relay")).toBeNull()
  })

  it("does not fetch or poll anything on its own", () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch")
    render(<StatusPageLinkBlock signalingUrl="wss://signaling.cognia.cn/signaling" />)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("explains a failed open without throwing", async () => {
    openExternalMock.mockRejectedValue(new Error("no browser"))
    render(<StatusPageLinkBlock signalingUrl="wss://relay.example.com/signaling" />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open public status page" }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent(STATUS_PAGE_URL)
  })
})
