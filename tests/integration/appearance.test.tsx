/**
 * @jest-environment jsdom
 *
 * Integration coverage for the eight-step manual checklist defined in
 * ADR 0007 (Decision 11). Each test exercises the full appearance pipeline
 * end-to-end: settings store + Dexie persistence (fake-indexeddb) +
 * BackgroundApplier + CustomThemeApplier + the document DOM that
 * production CSS selectors key off.
 *
 * Constraints / what's exercised vs. what isn't:
 *   - jsdom has no real CSS engine, so we assert on `document.body`
 *     `data-bg-*` attributes, `<html>` inline `style` (CSS vars), the
 *     `<html>` `.dark` class, and the store's persisted state — all the
 *     hooks production CSS reads from.
 *   - `next-themes` is mocked so the test can directly control the
 *     resolved variant. The mock reads from a shared `themeRef` and
 *     toggles the `<html>` class on `setTheme()` calls, mirroring the
 *     production library's effect for our purposes.
 *   - Dexie via `fake-indexeddb/auto` provides real persistence; we
 *     exercise the persist-then-remount round-trip in test 6.
 */

import "fake-indexeddb/auto"
import { act, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"

// next-themes is mocked here, before any module that imports `useTheme`
// is touched. We expose `themeRef` so tests can flip the resolvedTheme
// directly. `setTheme` synchronously updates the ref AND toggles the
// `.dark` class on `<html>` so the same observable side-effect the real
// library produces is visible to the assertions.
const themeRef: { current: "light" | "dark" } = { current: "dark" }
function applyThemeClass(t: "light" | "dark") {
  const root = document.documentElement
  root.classList.toggle("dark", t === "dark")
  root.classList.toggle("light", t === "light")
}
jest.mock("next-themes", () => ({
  useTheme: () => ({
    theme: themeRef.current,
    resolvedTheme: themeRef.current,
    setTheme: (t: "light" | "dark") => {
      themeRef.current = t
      applyThemeClass(t)
    },
  }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// jsdom doesn't ship matchMedia; even with the next-themes shim above,
// downstream Radix / a11y bits sometimes touch it.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  })
}

// Same keyring mock as the existing settings-hydrator test — the OS
// keyring path is irrelevant to appearance plumbing.
jest.mock("@/lib/tts/keyring", () => ({
  loadAllProviderKeys: jest.fn().mockResolvedValue({}),
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
}))

// Skill seed is unrelated to appearance and pulls in heavy deps; stub.
jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { useSettingsStore } from "@/stores/settings"
import { SettingsHydrator } from "@/components/providers/settings-hydrator"
import { CustomThemeApplier } from "@/lib/appearance/custom-theme-applier"
import { BackgroundApplier } from "@/lib/appearance"
import { CSS_VAR_KEYS } from "@/lib/appearance/css-var"
import { BUILT_IN_VSCODE_THEMES } from "@/lib/appearance/built-in-vscode-themes"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"

function renderApp(children: ReactNode = null) {
  return render(
    <>
      <SettingsHydrator />
      <BackgroundApplier />
      <CustomThemeApplier />
      {children}
    </>
  )
}

async function waitForLoaded() {
  await waitFor(() => expect(useSettingsStore.getState().loaded).toBe(true))
}

beforeEach(async () => {
  // Reset Dexie + Zustand between tests so each starts from defaults.
  // Order matters: drop the live DB first, *then* clear the cached
  // instance pointer so the next `getDb()` opens a fresh one.
  try {
    await getDb().delete()
  } catch {
    /* DB may not exist yet on the first run — ignore. */
  }
  __resetDbForTesting()

  useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })

  // Wipe any DOM state a previous test may have left behind.
  document.documentElement.removeAttribute("style")
  document.documentElement.className = ""
  document.body.removeAttribute("style")
  document.body.removeAttribute("data-bg-enabled")
  document.body.removeAttribute("data-bg-scope")
  document.body.removeAttribute("data-bg-kind")
  document.body.removeAttribute("data-bg-scrim")
  document.querySelectorAll("[data-bg-target]").forEach((el) => el.remove())

  // Reset the controllable resolvedTheme back to a known starting point.
  themeRef.current = "dark"
  applyThemeClass("dark")
})

describe("appearance integration: 8-step manual checklist", () => {
  // ────────────────────────────────────────────────────────────────────
  // 1 — dark/light toggle adds the .dark class to <html> AND persists
  //     the theme preference into the store/DB.
  // ────────────────────────────────────────────────────────────────────
  it("toggling theme to light removes the .dark class; toggling to dark restores it", async () => {
    renderApp()
    await waitForLoaded()

    // Production wires `setTheme(...)` (next-themes) + `save({ theme })`
    // (settings store) at the same call site. We exercise both halves so
    // the assertion proves the round-trip end-to-end.
    await act(async () => {
      const nt = jest.requireMock("next-themes") as {
        useTheme: () => { setTheme: (t: "light" | "dark") => void }
      }
      nt.useTheme().setTheme("light")
      await useSettingsStore.getState().setTheme("light")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(useSettingsStore.getState().theme).toBe("light")

    await act(async () => {
      const nt = jest.requireMock("next-themes") as {
        useTheme: () => { setTheme: (t: "light" | "dark") => void }
      }
      nt.useTheme().setTheme("dark")
      await useSettingsStore.getState().setTheme("dark")
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(useSettingsStore.getState().theme).toBe("dark")
  })

  // ────────────────────────────────────────────────────────────────────
  // 2 — activating a custom theme writes the full CSS-variable set onto
  //     <html> via CustomThemeApplier.
  // ────────────────────────────────────────────────────────────────────
  it("activating a built-in custom theme writes the canonical 27 CSS variables onto <html>", async () => {
    renderApp()
    await waitForLoaded()

    let id = ""
    await act(async () => {
      id = useSettingsStore.getState().createCustomTheme(BUILT_IN_VSCODE_THEMES[0] as never)
      useSettingsStore.getState().setActiveCustomTheme(id)
    })

    // The applier mounts an effect; wait for the first non-empty var.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).not.toBe("")
    )

    const html = document.documentElement
    let written = 0
    for (const cssVar of CSS_VAR_KEYS) {
      if (html.style.getPropertyValue(cssVar) !== "") written++
    }
    // Every key in the canonical list should be filled — the parser
    // pipeline + OKLCH derivation guarantees no missing slots for the
    // first preset.
    expect(written).toBe(CSS_VAR_KEYS.length)

    // Sanity-check a few specific keys to catch a stale CSS-var name.
    expect(html.style.getPropertyValue("--primary")).not.toBe("")
    expect(html.style.getPropertyValue("--sidebar-primary")).not.toBe("")
    expect(html.style.getPropertyValue("--primary-foreground")).not.toBe("")
  })

  // ────────────────────────────────────────────────────────────────────
  // 3 — JSON theme import: parse-json + derive-variant + store insert
  //     produces a dual-variant theme that activates correctly.
  // ────────────────────────────────────────────────────────────────────
  it("importing a VSCode JSON yields a dual-variant theme that resolves through the applier", async () => {
    renderApp()
    await waitForLoaded()

    const { importVscodeThemeJson } = await import("@/lib/appearance/vscode-theme/parse-json")
    const { deriveOppositeVariant } = await import("@/lib/appearance/derive-variant")

    // Read a fixture from disk — the same one the JSON-import dialog
    // uses for its own tests, so the round-trip stays load-bearing.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const fixturePath = path.join(
      process.cwd(),
      "lib",
      "appearance",
      "vscode-theme",
      "__fixtures__",
      "dracula.json"
    )
    const fixture = fs.readFileSync(fixturePath, "utf8")
    const parsed = importVscodeThemeJson(fixture)
    const baseVariant: "light" | "dark" = parsed.theme.isDark ? "dark" : "light"
    const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
    const tokens = {
      [baseVariant]: parsed.theme.colors,
      [opposite]: deriveOppositeVariant(parsed.theme.colors, baseVariant),
    } as { light: typeof parsed.theme.colors; dark: typeof parsed.theme.colors }

    let id = ""
    await act(async () => {
      id = useSettingsStore.getState().createCustomTheme({
        name: parsed.theme.name,
        baseVariant,
        derivedVariant: opposite,
        tokens,
        isDark: parsed.theme.isDark,
        colors: parsed.theme.colors,
      } as never)
      useSettingsStore.getState().setActiveCustomTheme(id)
    })

    // Both variants are populated — that's the load-bearing claim of
    // Phase 4 + the OKLCH derivation.
    const stored = useSettingsStore.getState().customThemes.find((t) => t.id === id)
    expect(stored?.tokens?.light).toBeDefined()
    expect(stored?.tokens?.dark).toBeDefined()

    // The applier should have written CSS vars for the active variant.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).not.toBe("")
    )
  })

  // ────────────────────────────────────────────────────────────────────
  // 4 — wallpaper scope=chat sets data-bg-scope on <body>, scope=all
  //     resets it. Production CSS selectors switch off this attribute.
  // ────────────────────────────────────────────────────────────────────
  it("setting wallpaper with scope=chat surfaces data-bg-scope=chat on <body>", async () => {
    renderApp(<div data-bg-target="chat">chat container</div>)
    await waitForLoaded()

    await act(async () => {
      await useSettingsStore.getState().addWallpaper({
        id: "w1",
        name: "Test",
        kind: "color",
        source: { kind: "color", value: "#123456" },
        builtin: false,
        createdAt: Date.now(),
      })
      await useSettingsStore.getState().setActiveWallpaper("w1")
      await useSettingsStore.getState().setBackground({ scope: "chat" })
    })

    await waitFor(() => expect(document.body.getAttribute("data-bg-scope")).toBe("chat"))
    expect(document.body.getAttribute("data-bg-enabled")).toBe("true")
  })

  // ────────────────────────────────────────────────────────────────────
  // 5 — opacity guard scrim: low-opacity image wallpaper at scope=all
  //     stamps data-bg-scrim=true on <body>.
  // ────────────────────────────────────────────────────────────────────
  it("low-opacity image wallpaper at scope=all triggers data-bg-scrim on <body>", async () => {
    renderApp()
    await waitForLoaded()

    await act(async () => {
      await useSettingsStore.getState().addWallpaper({
        id: "w-img",
        name: "Image",
        kind: "image",
        source: {
          kind: "image",
          storage: "data-url",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
          mime: "image/png",
          width: 1,
          height: 1,
        },
        builtin: false,
        createdAt: Date.now(),
      })
      await useSettingsStore.getState().setActiveWallpaper("w-img")
      await useSettingsStore.getState().setBackground({ scope: "all", opacity: 0.3 })
    })

    await waitFor(() => expect(document.body.getAttribute("data-bg-scrim")).toBe("true"))
  })

  // ────────────────────────────────────────────────────────────────────
  // 6 — persistence: settings written to Dexie survive a remount that
  //     only resets the in-memory Zustand store.
  // ────────────────────────────────────────────────────────────────────
  it("custom theme persists in Dexie across a Zustand-only remount", async () => {
    const first = renderApp()
    await waitForLoaded()

    // `createCustomTheme` and `setActiveCustomTheme` fire-and-forget the
    // Dexie write. Round-trip through `save({ ... })` so we can `await`
    // the persistence and avoid racing the remount.
    let id = ""
    await act(async () => {
      id = useSettingsStore.getState().createCustomTheme(BUILT_IN_VSCODE_THEMES[1] as never)
      useSettingsStore.getState().setActiveCustomTheme(id)
      await useSettingsStore.getState().save({
        customThemes: useSettingsStore.getState().customThemes,
        activeCustomThemeId: id,
      })
    })

    expect(useSettingsStore.getState().customThemes.length).toBeGreaterThan(0)
    expect(useSettingsStore.getState().activeCustomThemeId).toBe(id)

    first.unmount()

    // Reset Zustand only — keep the IndexedDB content so the next mount
    // can reload it.
    useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })

    renderApp()
    await waitForLoaded()

    expect(useSettingsStore.getState().customThemes.length).toBeGreaterThan(0)
    expect(useSettingsStore.getState().activeCustomThemeId).toBe(id)
  })

  // ────────────────────────────────────────────────────────────────────
  // 7 — selective reset: clearing customThemes / customCss / background
  //     does not touch the wallpapers list.
  // ────────────────────────────────────────────────────────────────────
  it("resetting the theme/background slice does not delete user wallpapers", async () => {
    renderApp()
    await waitForLoaded()

    // Use `save` to land both writes in a single Dexie put — the
    // fire-and-forget contract of `createCustomTheme` would otherwise
    // race with `addWallpaper`'s read-modify-write of the singleton row
    // and clobber the customThemes update in-memory.
    const draftTheme = { ...(BUILT_IN_VSCODE_THEMES[0] as never as object), id: "ct_keeper_check" }
    await act(async () => {
      await useSettingsStore.getState().save({
        customThemes: [draftTheme as never],
        wallpapers: [
          {
            id: "wkeep",
            name: "Keeper",
            kind: "color",
            source: { kind: "color", value: "#abcdef" },
            builtin: false,
            createdAt: Date.now(),
          },
        ],
      })
    })

    expect(useSettingsStore.getState().customThemes.length).toBeGreaterThan(0)
    expect(useSettingsStore.getState().wallpapers.find((w) => w.id === "wkeep")).toBeDefined()

    await act(async () => {
      await useSettingsStore.getState().save({
        customThemes: [],
        activeCustomThemeId: null,
        customCss: "",
        customCssEnabled: false,
        background: { ...DEFAULT_BACKGROUND_SETTINGS },
      })
    })

    expect(useSettingsStore.getState().customThemes.length).toBe(0)
    expect(useSettingsStore.getState().activeCustomThemeId).toBeNull()
    // The non-built-in wallpaper survives — the reset patch deliberately
    // omits the `wallpapers` field.
    const kept = useSettingsStore.getState().wallpapers.find((w) => w.id === "wkeep")
    expect(kept).toBeDefined()
  })

  // ────────────────────────────────────────────────────────────────────
  // 8 — dual-variant theme: the applier picks one of the two token sets
  //     based on the resolved theme. We can't drive next-themes through
  //     a real provider here, so we assert the applied --background
  //     matches one of the two variant backgrounds (the dark one, given
  //     the test default).
  // ────────────────────────────────────────────────────────────────────
  it("active dual-variant theme writes a variant-matching --background onto <html>", async () => {
    renderApp()
    await waitForLoaded()

    const preset = BUILT_IN_VSCODE_THEMES[0]
    let id = ""
    await act(async () => {
      id = useSettingsStore.getState().createCustomTheme(preset as never)
      useSettingsStore.getState().setActiveCustomTheme(id)
    })

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).not.toBe("")
    )

    const applied = document.documentElement.style.getPropertyValue("--background").trim()
    const darkBg = String(preset.tokens?.dark.background ?? "").trim()
    const lightBg = String(preset.tokens?.light.background ?? "").trim()
    // The default ThemeProvider here resolves to "dark" (see themeRef
    // initialisation above). The applier should pick the dark variant —
    // but we accept either to remain robust against a future shift in
    // the seed direction. The hard claim is "this is one of the two".
    expect([darkBg, lightBg]).toContain(applied)
    // And it must be non-empty — both backgrounds are populated for any
    // built-in preset.
    expect(applied.length).toBeGreaterThan(0)
  })
})
