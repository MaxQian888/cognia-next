import { act, render, screen, waitFor } from "@testing-library/react"

import { McpAppFrame } from "./mcp-app-frame"

const bridges: MockBridge[] = []

class MockBridge {
  oncalltool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>
  onopenlink?: (params: { url: string }) => Promise<unknown>
  ondownloadfile?: (params: { contents: unknown[] }) => Promise<unknown>
  onsizechange?: (params: { height?: number }) => void
  onsandboxready?: () => void
  oninitialized?: () => void
  connect = jest.fn(async () => undefined)
  close = jest.fn(async () => undefined)
  sendSandboxResourceReady = jest.fn(async () => undefined)
  sendToolInput = jest.fn(async () => undefined)
  sendToolResult = jest.fn(async () => undefined)

  constructor() {
    bridges.push(this)
  }
}

jest.mock("@modelcontextprotocol/ext-apps/app-bridge", () => ({
  AppBridge: MockBridge,
  PostMessageTransport: class {},
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    key === "frameTitle" ? `App from ${values?.server}` : key,
}))

const provenance = { serverId: "figma", serverName: "Figma", resourceUri: "ui://figma/app" }

function baseProps() {
  return {
    html: "<html><head></head><body>Figma App</body></html>",
    approvals: {},
    provenance,
    authorizeToolCall: jest.fn(async () => true),
    callTool: jest.fn(async () => ({ content: [] })),
  }
}

describe("McpAppFrame", () => {
  beforeEach(() => bridges.splice(0))

  it("blocks rendering until every requested capability is approved", () => {
    render(
      <McpAppFrame
        {...baseProps()}
        csp={{ connectDomains: ["https://api.figma.com"] }}
        permissions={{ camera: {} }}
      />
    )
    expect(screen.getByRole("alert")).toHaveTextContent("approvalRequired")
    expect(screen.queryByTitle("App from Figma")).not.toBeInTheDocument()
  })

  it("mounts an opaque AppBridge proxy for approved resources", async () => {
    render(<McpAppFrame {...baseProps()} />)
    const frame = screen.getByTitle("App from Figma")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame).not.toHaveAttribute("allow")
    await waitFor(() => expect(bridges).toHaveLength(1))
    await waitFor(() =>
      expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("sandbox-proxy-ready"))
    )
  })

  it("re-authorizes every iframe tool call through the host grant callback", async () => {
    const props = baseProps()
    props.authorizeToolCall.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<McpAppFrame {...props} />)
    await waitFor(() => expect(bridges).toHaveLength(1))
    const bridge = bridges[0]

    await expect(
      bridge.oncalltool?.({ name: "update_file", arguments: { id: "1" } })
    ).resolves.toEqual({
      isError: true,
      content: [],
    })
    await bridge.oncalltool?.({ name: "update_file", arguments: { id: "1" } })
    expect(props.authorizeToolCall).toHaveBeenCalledTimes(2)
    expect(props.callTool).toHaveBeenCalledWith({
      name: "update_file",
      arguments: { id: "1" },
      provenance,
    })
  })

  it("requires confirmation for links and sends downloads to quarantine", async () => {
    const confirmOpenLink = jest.fn(async () => true)
    const openLink = jest.fn()
    const confirmDownload = jest.fn(async () => true)
    const quarantineDownload = jest.fn()
    render(
      <McpAppFrame
        {...baseProps()}
        confirmOpenLink={confirmOpenLink}
        openLink={openLink}
        confirmDownload={confirmDownload}
        quarantineDownload={quarantineDownload}
      />
    )
    await waitFor(() => expect(bridges).toHaveLength(1))
    await act(async () => {
      await bridges[0].onopenlink?.({ url: "https://www.figma.com/file/1" })
      await bridges[0].ondownloadfile?.({ contents: [{ type: "resource_link", uri: "x" }] })
    })
    expect(confirmOpenLink).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "www.figma.com", provenance })
    )
    expect(openLink).toHaveBeenCalledWith("https://www.figma.com/file/1")
    expect(confirmDownload).toHaveBeenCalled()
    expect(quarantineDownload).toHaveBeenCalled()
  })
})
