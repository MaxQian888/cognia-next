/**
 * @jest-environment node
 */
import path from "node:path"

import { configDir, endpointFilePath, parseEndpoint, ENDPOINT_FILE_REL } from "./endpoint"

describe("configDir", () => {
  it("uses APPDATA on win32", () => {
    expect(configDir("win32", { APPDATA: "C:/Users/u/AppData/Roaming" }, "C:/Users/u")).toBe(
      "C:/Users/u/AppData/Roaming"
    )
  })
  it("falls back to ~/AppData/Roaming on win32 without APPDATA", () => {
    expect(configDir("win32", {}, "C:/Users/u")).toBe(path.join("C:/Users/u", "AppData", "Roaming"))
  })
  it("uses Library/Application Support on darwin", () => {
    expect(configDir("darwin", {}, "/Users/u")).toBe(
      path.join("/Users/u", "Library", "Application Support")
    )
  })
  it("uses XDG_CONFIG_HOME on linux when set", () => {
    expect(configDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg")
  })
  it("falls back to ~/.config on linux", () => {
    expect(configDir("linux", {}, "/home/u")).toBe(path.join("/home/u", ".config"))
  })
})

describe("endpointFilePath", () => {
  it("honours COGNIA_CLI_ENDPOINT_FILE override", () => {
    expect(endpointFilePath("linux", { COGNIA_CLI_ENDPOINT_FILE: "/x/ep.json" }, "/home/u")).toBe(
      "/x/ep.json"
    )
  })
  it("composes config dir + the relative path", () => {
    expect(endpointFilePath("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe(
      path.join("/cfg", ENDPOINT_FILE_REL)
    )
  })
})

describe("parseEndpoint", () => {
  it("parses a valid endpoint file", () => {
    expect(parseEndpoint('{"baseUrl":"http://127.0.0.1:42","devToken":"tok"}')).toEqual({
      baseUrl: "http://127.0.0.1:42",
      devToken: "tok",
    })
  })
  it("returns null for missing file", () => {
    expect(parseEndpoint(null)).toBeNull()
  })
  it("returns null for invalid JSON", () => {
    expect(parseEndpoint("{bad")).toBeNull()
  })
  it("returns null when fields are missing", () => {
    expect(parseEndpoint('{"baseUrl":"x"}')).toBeNull()
  })
})
