/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

import { AppearancePreview } from "./appearance-preview"
import type { ThemeColors } from "@/types/plugin/plugin"

// A complete token set — the component's contract is "never pass a sparse
// object", so the fixture honors it. Values are deliberately distinguishable.
const DRAFT: ThemeColors = {
  primary: "#ff0000",
  primaryForeground: "#ffffff",
  secondary: "#00ff00",
  secondaryForeground: "#000000",
  accent: "#0000ff",
  accentForeground: "#ffffff",
  background: "#111111",
  foreground: "#eeeeee",
  muted: "#222222",
  mutedForeground: "#999999",
  card: "#181818",
  cardForeground: "#dddddd",
  popover: "#202020",
  popoverForeground: "#cccccc",
  input: "#333333",
  border: "#444444",
  ring: "#ff00ff",
  destructive: "#cc0000",
  destructiveForeground: "#ffffff",
  sidebar: "#0a0a0a",
  sidebarForeground: "#bbbbbb",
  sidebarPrimary: "#ff8800",
  sidebarBorder: "#555555",
  sidebarPrimaryForeground: "#000000",
  sidebarAccent: "#008888",
  sidebarAccentForeground: "#ffffff",
  sidebarRing: "#88ff00",
}

describe("AppearancePreview", () => {
  it("renders the sample surfaces", () => {
    render(<AppearancePreview />)
    expect(screen.getByTestId("appearance-preview")).toBeInTheDocument()
    // A button of every variant + the chat bubbles + the code line are present.
    expect(screen.getByText("buttons.primary")).toBeInTheDocument()
    expect(screen.getByText("buttons.destructive")).toBeInTheDocument()
    expect(screen.getByText("assistant")).toBeInTheDocument()
    expect(screen.getByText("user")).toBeInTheDocument()
    expect(screen.getByText("code")).toBeInTheDocument()
  })

  it("shows an accessible, non-interactive switch and input", () => {
    render(<AppearancePreview />)
    expect(screen.getByRole("switch", { name: "switchAria" })).toBeChecked()
    expect(screen.getByLabelText("inputAria")).toHaveAttribute("readonly")
  })

  it("forwards a className to the root", () => {
    render(<AppearancePreview className="custom-x" />)
    expect(screen.getByTestId("appearance-preview")).toHaveClass("custom-x")
  })

  describe("without colors", () => {
    it("styles through the applied theme, writing no scoped token vars", () => {
      render(<AppearancePreview />)
      const root = screen.getByTestId("appearance-preview")
      expect(root.style.getPropertyValue("--primary")).toBe("")
      expect(root).not.toHaveClass("dark")
    })

    it("omits the draft-only swatch strip", () => {
      render(<AppearancePreview />)
      expect(screen.queryByTestId("appearance-preview-swatches")).not.toBeInTheDocument()
    })
  })

  describe("with colors", () => {
    it("writes every token onto the root as a scoped CSS custom property", () => {
      render(<AppearancePreview colors={DRAFT} />)
      const root = screen.getByTestId("appearance-preview")
      // camelCase keys become kebab vars (themeKeyToCssVar).
      expect(root.style.getPropertyValue("--primary")).toBe("#ff0000")
      expect(root.style.getPropertyValue("--primary-foreground")).toBe("#ffffff")
      expect(root.style.getPropertyValue("--muted-foreground")).toBe("#999999")
      expect(root.style.getPropertyValue("--sidebar-primary-foreground")).toBe("#000000")
    })

    it("drops keys outside the ThemeColors allow-list", () => {
      // Drafts can come from importThemeFromJson, so an unknown key must not
      // reach the style object.
      const tainted = { ...DRAFT, evilKey: "red", constructor: "boom" } as ThemeColors
      render(<AppearancePreview colors={tainted} />)
      const root = screen.getByTestId("appearance-preview")
      expect(root.style.getPropertyValue("--evil-key")).toBe("")
      expect(root.style.getPropertyValue("--constructor")).toBe("")
      expect(root.style.getPropertyValue("--primary")).toBe("#ff0000")
    })

    it("skips empty token values rather than writing an empty var", () => {
      render(<AppearancePreview colors={{ ...DRAFT, ring: "" }} />)
      expect(screen.getByTestId("appearance-preview").style.getPropertyValue("--ring")).toBe("")
    })

    it("renders the swatch strip so accent/ring/popover are not inert", () => {
      render(<AppearancePreview colors={DRAFT} />)
      expect(screen.getByTestId("appearance-preview-swatches")).toBeInTheDocument()
      for (const key of ["accent", "accentForeground", "ring", "popover", "popoverForeground"]) {
        expect(screen.getByTestId(`appearance-preview-swatch-${key}`)).toBeInTheDocument()
      }
    })

    // globals.css declares `@custom-variant dark (&:is(.dark *))` — a descendant
    // selector — and the shadcn primitives rendered here carry `dark:` variants.
    // Without the class, a dark draft under a light app renders light-mode
    // variants painted with dark tokens.
    it("marks the root dark so descendant dark: variants resolve", () => {
      render(<AppearancePreview colors={DRAFT} isDark />)
      expect(screen.getByTestId("appearance-preview")).toHaveClass("dark")
    })

    it("stays light when the draft is a light theme", () => {
      render(<AppearancePreview colors={DRAFT} isDark={false} />)
      expect(screen.getByTestId("appearance-preview")).not.toHaveClass("dark")
    })

    it("ignores isDark when previewing the applied theme", () => {
      render(<AppearancePreview isDark />)
      expect(screen.getByTestId("appearance-preview")).not.toHaveClass("dark")
    })
  })
})
