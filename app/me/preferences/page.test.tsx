/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"

const saveMock = jest.fn(async (_patch: Record<string, unknown>): Promise<void> => undefined)
const enqueueMock = jest.fn(async (_arg: unknown): Promise<void> => undefined)

const settingsRef: { current: Record<string, unknown> | undefined } = {
  current: {
    fontScale: "md",
    defaultModel: "",
    biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (s: {
      settings: Record<string, unknown> | undefined
      save: (patch: Record<string, unknown>) => Promise<void>
    }) => unknown
  ) =>
    selector({
      settings: settingsRef.current,
      save: async (patch: Record<string, unknown>) => {
        if (settingsRef.current) {
          settingsRef.current = { ...settingsRef.current, ...patch }
        }
        await saveMock(patch)
      },
    }),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (arg: unknown) => enqueueMock(arg),
}))

// Render the Radix Select as a native <select> so `onValueChange` is testable.
jest.mock("@/components/ui/select", () => {
  const React = jest.requireActual("react")
  const collect = (nodes: unknown, items: unknown[], meta: { testid?: string }) => {
    React.Children.forEach(
      nodes,
      (child: { type?: { __isItem?: boolean }; props?: Record<string, unknown> }) => {
        if (!child || typeof child !== "object" || !child.props) return
        if (child.props["data-testid"]) meta.testid = child.props["data-testid"] as string
        if (child.type?.__isItem) items.push(child)
        else if (child.props.children) collect(child.props.children, items, meta)
      }
    )
  }
  const Select = ({ value, onValueChange, children }: Record<string, unknown>) => {
    const items: { props: { value: string; children: unknown } }[] = []
    const meta: { testid?: string } = {}
    collect(children, items as unknown[], meta)
    return React.createElement(
      "select",
      {
        "data-testid": meta.testid,
        value,
        onChange: (e: { target: { value: string } }) =>
          (onValueChange as (v: string) => void)(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props.value, value: it.props.value },
          it.props.children
        )
      )
    )
  }
  const SelectTrigger = () => null
  const SelectValue = () => null
  const SelectContent = ({ children }: { children: unknown }) => children
  const SelectItem = (props: unknown) => props
  ;(SelectItem as { __isItem?: boolean }).__isItem = true
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import Page from "./page"

beforeEach(() => {
  saveMock.mockReset()
  enqueueMock.mockReset()
  settingsRef.current = {
    fontScale: "md",
    defaultModel: "",
    biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
  }
})

describe("MobilePreferencesPage", () => {
  it("renders font-scale + default-model + four biometric rows", () => {
    render(<Page />)
    expect(screen.getByTestId("pref-font-scale")).toBeInTheDocument()
    expect(screen.getByTestId("pref-default-model")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-delete-pairing")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-export-backup")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-reveal-secrets")).toBeInTheDocument()
    expect(screen.getByTestId("pref-biometric-sign-out")).toBeInTheDocument()
  })

  it("renders the accessibility & privacy toggles", () => {
    render(<Page />)
    expect(screen.getByTestId("pref-reduce-motion")).toBeInTheDocument()
    expect(screen.getByTestId("pref-telemetry")).toBeInTheDocument()
  })

  it("toggling reduce-motion persists and enqueues a server-bound update", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-reduce-motion"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ reduceMotion: true })
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("toggling telemetry persists the new value", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-telemetry"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ telemetryEnabled: true })
  })

  it("writes the default model patch and enqueues a server-bound update", async () => {
    render(<Page />)
    fireEvent.change(screen.getByTestId("pref-default-model"), {
      target: { value: "claude-sonnet-4-6" },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-6" })
    expect(enqueueMock).toHaveBeenCalled()
  })

  it("toggling the sign-out biometric switch persists the new policy", async () => {
    render(<Page />)
    fireEvent.click(screen.getByTestId("pref-biometric-sign-out"))
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      biometricRequiredFor: {
        ...DEFAULT_BIOMETRIC_GUARD,
        signOut: false,
      },
    })
  })

  it("changing the font scale persists the new value", async () => {
    render(<Page />)
    fireEvent.change(screen.getByTestId("pref-font-scale"), { target: { value: "lg" } })
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ fontScale: "lg" })
  })

  it.each([
    ["pref-biometric-delete-pairing", "deletePairing"],
    ["pref-biometric-export-backup", "exportBackup"],
    ["pref-biometric-reveal-secrets", "revealSecrets"],
  ] as const)("toggling %s merge-updates the guard", async (testid, key) => {
    const { unmount } = render(<Page />)
    fireEvent.click(screen.getByTestId(testid))
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD, [key]: !DEFAULT_BIOMETRIC_GUARD[key] },
    })
    unmount()
  })

  it("clearing the default model writes undefined (not an empty string)", async () => {
    settingsRef.current = {
      fontScale: "md",
      defaultModel: "claude-opus-4-8",
      biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },
    }
    render(<Page />)
    fireEvent.change(screen.getByTestId("pref-default-model"), { target: { value: "" } })
    await Promise.resolve()
    await Promise.resolve()
    expect(saveMock).toHaveBeenCalledWith({ defaultModel: undefined })
  })

  it("falls back to safe defaults when settings are absent", () => {
    settingsRef.current = undefined
    render(<Page />)
    expect(screen.getByTestId("pref-reduce-motion")).not.toBeChecked()
    expect(screen.getByTestId("pref-telemetry")).not.toBeChecked()
    expect(screen.getByTestId("pref-biometric-sign-out")).toBeInTheDocument()
  })
})
