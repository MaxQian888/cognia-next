import { resolveOnboardingShell, shellHasLocalRuntime } from "./shell"

describe("resolveOnboardingShell", () => {
  it("maps the Tauri webview to the desktop shell", () => {
    expect(resolveOnboardingShell("tauri", undefined)).toBe("tauri")
    // The desktop never carries a mobile runtime mode; a stray one must not win.
    expect(resolveOnboardingShell("tauri", "paired")).toBe("tauri")
  })

  it("maps a browser to the web shell", () => {
    expect(resolveOnboardingShell("web", undefined)).toBe("web")
  })

  it("maps the headless brain to the web shell so the resolver stays total", () => {
    expect(resolveOnboardingShell("headless", undefined)).toBe("web")
  })

  it("splits mobile by where the compute lives", () => {
    expect(resolveOnboardingShell("mobile", "paired")).toBe("mobile-paired")
    expect(resolveOnboardingShell("mobile", "standalone")).toBe("mobile-standalone")
  })

  it("treats an unchosen mobile mode as standalone so the mode fork is reachable", () => {
    // Resolving to `paired` would route a brand-new phone straight at the
    // pairing screen with no way to pick BYOK.
    expect(resolveOnboardingShell("mobile", undefined)).toBe("mobile-standalone")
  })
})

describe("shellHasLocalRuntime", () => {
  it("is true only on the desktop", () => {
    expect(shellHasLocalRuntime("tauri")).toBe(true)
  })

  it.each(["web", "mobile-standalone", "mobile-paired"] as const)("is false for %s", (shell) => {
    expect(shellHasLocalRuntime(shell)).toBe(false)
  })
})
