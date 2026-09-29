jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  detectDevServers,
  localPathFromAddress,
  serveLocalFile,
  stopLocalFile,
} from "./local-content-client"

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

it("serves and stops local files through the Rust loopback server", async () => {
  call.mockResolvedValueOnce({ url: "http://127.0.0.1:5000/abc/index.html", root: "abc" })
  await expect(serveLocalFile("/tmp/site/index.html")).resolves.toEqual({
    url: "http://127.0.0.1:5000/abc/index.html",
    root: "abc",
  })
  expect(call).toHaveBeenCalledWith("browser_local_file_serve", { path: "/tmp/site/index.html" })
  call.mockResolvedValueOnce(undefined)
  await stopLocalFile("abc")
  expect(call).toHaveBeenLastCalledWith("browser_local_file_stop", { root: "abc" })
})

it("lists detected dev servers", async () => {
  const servers = [
    { url: "http://localhost:3000", port: 3000, pid: 1, process: "node", title: null },
  ]
  call.mockResolvedValueOnce(servers)
  await expect(detectDevServers()).resolves.toEqual(servers)
  expect(call).toHaveBeenCalledWith("browser_dev_servers_detect")
})

describe("localPathFromAddress", () => {
  it.each([
    ["/Users/me/site/index.html", "/Users/me/site/index.html"],
    ["~/site", "~/site"],
    ["C:\\site\\index.html", "C:\\site\\index.html"],
    ["\\\\server\\share\\a.html", "\\\\server\\share\\a.html"],
    ["file:///Users/me/a%20b.html", "/Users/me/a b.html"],
    ["file:///C:/site/index.html", "C:/site/index.html"],
    ["file://localhost/tmp/x.html", "/tmp/x.html"],
    ["file://server/share/x.html", "//server/share/x.html"],
  ])("recognises %s", (input, path) => {
    expect(localPathFromAddress(input)).toBe(path)
  })

  it.each([
    "",
    "  ",
    "example.com",
    "https://example.com/a",
    "//cdn.example.com/x",
    "localhost:3000",
  ])("leaves %p alone", (input) => {
    expect(localPathFromAddress(input)).toBeNull()
  })
})
