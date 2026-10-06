import { createAgentTransportFileHost } from "./file-host"

const transport = {
  supportsAgentFs: jest.fn(() => true),
  agentReadTextFile: jest.fn(async () => "body"),
  agentWriteTextFile: jest.fn(async () => undefined),
  agentDeleteTextFile: jest.fn(async () => undefined),
  agentReadBinaryFile: jest.fn(async () => "AAE="),
  agentWriteBinaryFile: jest.fn(async () => undefined),
  agentListFiles: jest.fn(async () => ["/w/a.json"]),
}

jest.mock("../agent-transport", () => ({
  supportsAgentFs: () => transport.supportsAgentFs(),
  agentReadTextFile: (...args: unknown[]) => transport.agentReadTextFile(...(args as [])),
  agentWriteTextFile: (...args: unknown[]) => transport.agentWriteTextFile(...(args as [])),
  agentDeleteTextFile: (...args: unknown[]) => transport.agentDeleteTextFile(...(args as [])),
  agentReadBinaryFile: (...args: unknown[]) => transport.agentReadBinaryFile(...(args as [])),
  agentWriteBinaryFile: (...args: unknown[]) => transport.agentWriteBinaryFile(...(args as [])),
  agentListFiles: (...args: unknown[]) => transport.agentListFiles(...(args as [])),
}))

describe("createAgentTransportFileHost", () => {
  beforeEach(() => jest.clearAllMocks())

  it("reads availability from the transport on every access", () => {
    const host = createAgentTransportFileHost()
    expect(host.available).toBe(true)
    transport.supportsAgentFs.mockReturnValueOnce(false)
    expect(host.available).toBe(false)
  })

  it("routes each operation through the confined workspace file commands with its roots", async () => {
    const host = createAgentTransportFileHost()
    const roots = Object.freeze(["/w"])
    await expect(host.readText("/w/a.md", roots)).resolves.toBe("body")
    await host.writeText("/w/b.md", "text", roots)
    await host.delete("/w/c.md", roots)
    expect(transport.agentReadTextFile).toHaveBeenCalledWith("/w/a.md", ["/w"])
    expect(transport.agentWriteTextFile).toHaveBeenCalledWith("/w/b.md", "text", ["/w"])
    expect(transport.agentDeleteTextFile).toHaveBeenCalledWith("/w/c.md", ["/w"])
  })

  it("routes binary reads, writes and listings through the same confined commands", async () => {
    const host = createAgentTransportFileHost()
    await expect(host.readBinary("/w/i.png", ["/w"])).resolves.toBe("AAE=")
    await host.writeBinary("/w/o.png", "AAE=", ["/w"])
    await expect(host.listFiles("/w", ["/w"])).resolves.toEqual(["/w/a.json"])
    expect(transport.agentReadBinaryFile).toHaveBeenCalledWith("/w/i.png", ["/w"])
    expect(transport.agentWriteBinaryFile).toHaveBeenCalledWith("/w/o.png", "AAE=", ["/w"])
    expect(transport.agentListFiles).toHaveBeenCalledWith("/w", ["/w"])
  })

  it("surfaces transport failures unchanged", async () => {
    transport.agentReadTextFile.mockRejectedValueOnce(new Error("outside workspace"))
    await expect(createAgentTransportFileHost().readText("/etc/passwd", ["/w"])).rejects.toThrow(
      "outside workspace"
    )
  })

  it("uses the sandbox's lexical containment", () => {
    const host = createAgentTransportFileHost()
    expect(host.isWithinRoot("/w/src/a.ts", "/w")).toBe(true)
    expect(host.isWithinRoot("/w", "/w/")).toBe(true)
    expect(host.isWithinRoot("/wx/a.ts", "/w")).toBe(false)
  })
})
