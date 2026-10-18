import en from "@/i18n/messages/en/remoteDesktop.json"
import zh from "@/i18n/messages/zh-CN/remoteDesktop.json"

import { errorKeyOf, REMOTE_DESKTOP_ERROR_CODES, remoteDesktopErrorMessage } from "./error-messages"

describe("remote desktop error messages", () => {
  it("camel-cases the code suffix", () => {
    expect(errorKeyOf("remote_desktop_binding_cannot_be_read_only")).toBe("bindingCannotBeReadOnly")
    expect(remoteDesktopErrorMessage("remote_desktop_auth_failed", "bad password")).toEqual({
      key: "authFailed",
      values: { detail: "bad password", code: "remote_desktop_auth_failed" },
    })
  })

  it("names an unknown code instead of hiding it", () => {
    expect(remoteDesktopErrorMessage("remote_desktop_new_thing")).toEqual({
      key: "unknown",
      values: { code: "remote_desktop_new_thing" },
    })
  })

  it("has a message for every code in both locales", () => {
    for (const messages of [en, zh]) {
      const errors = messages.errors as Record<string, string>
      for (const code of REMOTE_DESKTOP_ERROR_CODES) {
        expect(errors[errorKeyOf(code)]).toEqual(expect.any(String))
      }
      expect(errors.unknown).toContain("{code}")
    }
  })
})
