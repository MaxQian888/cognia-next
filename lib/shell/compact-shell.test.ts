import { usesCompactShell } from "./compact-shell"

describe("usesCompactShell", () => {
  it("gives the compact shell to a narrow browser tab", () => {
    // The regression this whole split exists for: `platform === "mobile"` said
    // false here, so a 375px browser rendered the desktop workspace.
    expect(usesCompactShell("web", true)).toBe(true)
  })

  it("keeps the desktop shell for a wide browser tab", () => {
    expect(usesCompactShell("web", false)).toBe(false)
  })

  it("always gives the compact shell to a native mobile runtime", () => {
    // Tablet-width Capacitor still wants the phone frame.
    expect(usesCompactShell("mobile", false)).toBe(true)
    expect(usesCompactShell("mobile", true)).toBe(true)
  })

  it("never takes the desktop frame away from Tauri", () => {
    // `decorations: false` means our TitleBar owns the window controls.
    expect(usesCompactShell("tauri", true)).toBe(false)
    expect(usesCompactShell("tauri", false)).toBe(false)
  })

  it("leaves the headless host on the desktop branch", () => {
    expect(usesCompactShell("headless", true)).toBe(false)
  })
})
