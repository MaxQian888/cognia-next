jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  copyCredential,
  deleteCredential,
  exportCredentials,
  fillCredential,
  getPendingSave,
  importPasswordsFromBrowser,
  importPasswordsFromCsv,
  listCredentials,
  listPasswordSources,
  matchCredentials,
  resolvePendingSave,
  revealCredential,
  saveCredential,
  updateCredential,
  userPresenceErrorCode,
} from "./passwords"

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

const meta = {
  id: "c1",
  origin: "https://github.com",
  realm: null,
  username: "me",
  source: "manual",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  note: null,
}

it("lists sources, credentials and matches as metadata", async () => {
  call.mockResolvedValueOnce([])
  await listPasswordSources()
  expect(call).toHaveBeenLastCalledWith("browser_password_sources", {})

  call.mockResolvedValueOnce([meta])
  await expect(listCredentials()).resolves.toEqual([meta])
  expect(call).toHaveBeenLastCalledWith("browser_password_list", {})

  call.mockResolvedValueOnce([meta])
  await matchCredentials("https://www.github.com/login")
  expect(call).toHaveBeenLastCalledWith("browser_password_matches", {
    url: "https://www.github.com/login",
  })
})

it("imports from a browser profile or a CSV file", async () => {
  const result = { imported: 3, updated: 1, skipped: 0, skippedAppBound: 2, errors: [] }
  call.mockResolvedValueOnce(result)
  await expect(importPasswordsFromBrowser("chrome", "Default")).resolves.toEqual(result)
  expect(call).toHaveBeenLastCalledWith("browser_password_import_browser", {
    browser: "chrome",
    profile: "Default",
  })

  call.mockResolvedValueOnce(result)
  await importPasswordsFromCsv("/tmp/export.csv", "bitwarden")
  expect(call).toHaveBeenLastCalledWith("browser_password_import_csv", {
    path: "/tmp/export.csv",
    format: "bitwarden",
  })

  call.mockResolvedValueOnce(result)
  await importPasswordsFromCsv("/tmp/export.csv")
  expect(call).toHaveBeenLastCalledWith("browser_password_import_csv", {
    path: "/tmp/export.csv",
    format: null,
  })
})

it("saves, updates and deletes with explicit nulls for absent fields", async () => {
  call.mockResolvedValueOnce(meta)
  await saveCredential({ origin: "https://github.com", username: "me", password: "pw" })
  expect(call).toHaveBeenLastCalledWith("browser_password_save", {
    input: { origin: "https://github.com", username: "me", password: "pw", note: null },
  })

  call.mockResolvedValueOnce(meta)
  await updateCredential({ id: "c1", note: "work" })
  expect(call).toHaveBeenLastCalledWith("browser_password_update", {
    input: { id: "c1", username: null, password: null, note: "work" },
  })

  call.mockResolvedValueOnce(undefined)
  await deleteCredential("c1")
  expect(call).toHaveBeenLastCalledWith("browser_password_delete", { id: "c1" })
})

it("reveals, copies and exports through presence-gated commands", async () => {
  call.mockResolvedValueOnce({ password: "pw" })
  await expect(revealCredential("c1")).resolves.toEqual({ password: "pw" })
  expect(call).toHaveBeenLastCalledWith("browser_password_reveal", { id: "c1" })

  call.mockResolvedValueOnce(undefined)
  await copyCredential("c1")
  expect(call).toHaveBeenLastCalledWith("browser_password_copy", { id: "c1" })

  call.mockResolvedValueOnce({ exported: 4 })
  await expect(exportCredentials()).resolves.toEqual({ exported: 4 })
  expect(call).toHaveBeenLastCalledWith("browser_password_export", {})
  call.mockResolvedValueOnce(null)
  await expect(exportCredentials()).resolves.toBeNull()
})

it("rejects presence failures with an Error carrying the code", async () => {
  call.mockRejectedValueOnce("user_presence_denied")
  const error = await revealCredential("c1").catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("user_presence_denied")
  expect(userPresenceErrorCode(error)).toBe("user_presence_denied")

  const original = new Error("user_presence_cancelled")
  call.mockRejectedValueOnce(original)
  await expect(copyCredential("c1")).rejects.toBe(original)

  call.mockRejectedValueOnce({ code: 1 })
  await expect(exportCredentials()).rejects.toThrow('{"code":1}')

  expect(userPresenceErrorCode("user_presence_unavailable")).toBe("user_presence_unavailable")
  expect(userPresenceErrorCode(new Error("other"))).toBeNull()
  expect(userPresenceErrorCode(42)).toBeNull()
})

it("resolves a pending save by id and action", async () => {
  call.mockResolvedValueOnce(null)
  await expect(resolvePendingSave("p1", "never")).resolves.toBeNull()
  expect(call).toHaveBeenLastCalledWith("browser_password_pending_resolve", {
    pendingId: "p1",
    action: "never",
  })
})

it("reads a pending save's vault classification by id", async () => {
  call.mockResolvedValueOnce({
    origin: "https://github.com",
    username: "me",
    kind: "update",
    id: "c1",
  })
  await expect(getPendingSave("p1")).resolves.toEqual({
    origin: "https://github.com",
    username: "me",
    kind: "update",
    id: "c1",
  })
  expect(call).toHaveBeenLastCalledWith("browser_password_pending_get", { pendingId: "p1" })

  call.mockResolvedValueOnce(null)
  await expect(getPendingSave("gone")).resolves.toBeNull()

  call.mockRejectedValueOnce("vault_unavailable: locked")
  await expect(getPendingSave("p2")).rejects.toThrow("vault_unavailable: locked")
})

it("asks Rust to fill and normalizes absent fields to null", async () => {
  call.mockResolvedValueOnce({ filled: true, username: "me" })
  await expect(
    fillCredential({
      target: "local",
      sessionId: "s",
      pageId: "p",
      url: "https://github.com/login",
    })
  ).resolves.toEqual({ filled: true, username: "me", reason: null })
  expect(call).toHaveBeenLastCalledWith("browser_credential_fill", {
    request: {
      target: "local",
      sessionId: "s",
      pageId: "p",
      credentialId: null,
      url: "https://github.com/login",
    },
  })

  call.mockResolvedValueOnce({ filled: false, reason: "ambiguous" })
  await expect(
    fillCredential({ target: "embedded", credentialId: null, url: "https://a.com" })
  ).resolves.toEqual({ filled: false, username: null, reason: "ambiguous" })

  call.mockResolvedValueOnce(null)
  await expect(
    fillCredential({ target: "embedded", credentialId: "c1", url: "https://a.com" })
  ).resolves.toEqual({ filled: false, username: null, reason: null })
})
