// ADR-0028 — SandboxPolicyCard unit tests.

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import type { SandboxResourcePolicy } from "@/lib/claude/types"

import { findForbiddenWritableRoot, parseHostList, SandboxPolicyCard } from "./sandbox-policy-card"

let mockPolicy: SandboxResourcePolicy | undefined

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { settings: unknown }) => unknown) =>
    selector({ settings: { id: "singleton", sandboxPolicy: mockPolicy } }),
}))

jest.mock("@/lib/db/settings", () => ({
  saveSettings: jest.fn(),
}))

import { saveSettings } from "@/lib/db/settings"

const mockSave = saveSettings as jest.MockedFunction<typeof saveSettings>

const MESSAGES = {
  settings: {
    sandbox: {
      policy: {
        title: "Resource & network ceiling",
        description: "Max resources and network reach.",
        maxCpu: { label: "Max CPU seconds", description: "0 = backend default." },
        maxMemory: { label: "Max memory (MB)", description: "0 = backend default." },
        network: {
          label: "Network ceiling",
          description: "The most a shell may reach.",
          off: "Off (no network)",
          allowlist: "Allowlist only",
          on: "On (model decides)",
        },
        allowlist: {
          label: "Allowed hosts",
          description: "One host per line.",
          placeholder: "api.anthropic.com",
        },
        writableRoots: {
          label: "Writable roots",
          description: "One path per line.",
          placeholder: "/home/me/project",
          errorForbidden:
            "{path} cannot be used as a writable root. Choose a non-system directory.",
        },
      },
    },
  },
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <SandboxPolicyCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockPolicy = undefined
  mockSave.mockReset()
})

describe("parseHostList", () => {
  it("splits on newlines and commas, trimming and dropping blanks", () => {
    expect(parseHostList("a.com\n b.com , \n c.com")).toEqual(["a.com", "b.com", "c.com"])
    expect(parseHostList("   ")).toEqual([])
  })
})

describe("findForbiddenWritableRoot", () => {
  it("rejects system directories and their descendants", () => {
    expect(findForbiddenWritableRoot(["/home/me/project", "/usr/local/bin"])).toBe("/usr/local/bin")
    expect(findForbiddenWritableRoot(["C:\\ProgramData\\Cognia"])).toBe("C:\\ProgramData\\Cognia")
    expect(findForbiddenWritableRoot(["/home/me/project"])).toBeNull()
  })
})

describe("SandboxPolicyCard", () => {
  it("shows the current caps and defaults to 0 when unset", () => {
    renderCard()
    expect(screen.getByTestId("sandbox-policy-cpu")).toHaveValue(0)
    expect(screen.getByTestId("sandbox-policy-memory")).toHaveValue(0)
  })

  it("hides the allowlist textarea unless the network ceiling is 'allowlist'", () => {
    mockPolicy = { network: "on" }
    renderCard()
    expect(screen.queryByTestId("sandbox-policy-allowlist")).not.toBeInTheDocument()
  })

  it("shows the allowlist textarea with the configured hosts when ceiling is 'allowlist'", () => {
    mockPolicy = { network: "allowlist", networkAllowlist: ["api.github.com", "*.anthropic.com"] }
    renderCard()
    expect(screen.getByTestId("sandbox-policy-allowlist")).toHaveValue(
      "api.github.com\n*.anthropic.com"
    )
  })

  it("persists a normalized CPU cap on change", () => {
    renderCard()
    // A single change event — the store is mocked static, so the controlled
    // input can't accumulate keystrokes; one event carries the full value.
    fireEvent.change(screen.getByTestId("sandbox-policy-cpu"), { target: { value: "45" } })
    expect(mockSave).toHaveBeenLastCalledWith({ sandboxPolicy: { maxCpuSeconds: 45 } })
  })

  it("floors a negative memory cap to zero", () => {
    renderCard()
    fireEvent.change(screen.getByTestId("sandbox-policy-memory"), { target: { value: "-5" } })
    expect(mockSave).toHaveBeenLastCalledWith({ sandboxPolicy: { maxMemoryMb: 0 } })
  })

  it("persists the parsed host list on textarea blur", async () => {
    mockPolicy = { network: "allowlist", networkAllowlist: [] }
    renderCard()
    const hosts = screen.getByTestId("sandbox-policy-allowlist")
    fireEvent.change(hosts, { target: { value: "api.github.com, evil.com" } })
    fireEvent.blur(hosts)
    expect(mockSave).toHaveBeenCalledWith({
      sandboxPolicy: { network: "allowlist", networkAllowlist: ["api.github.com", "evil.com"] },
    })
  })

  it("persists the network ceiling when changed via the select", async () => {
    renderCard()
    fireEvent.click(screen.getByTestId("sandbox-policy-network"))
    fireEvent.click(await screen.findByRole("option", { name: "Off (no network)" }))
    expect(mockSave).toHaveBeenCalledWith({ sandboxPolicy: { network: "off" } })
  })

  it("persists the parsed writable-roots list on textarea blur", async () => {
    renderCard()
    const roots = screen.getByTestId("sandbox-policy-writable-roots")
    fireEvent.change(roots, { target: { value: "/home/me/projects, /tmp/work" } })
    fireEvent.blur(roots)
    expect(mockSave).toHaveBeenCalledWith({
      sandboxPolicy: { writableRoots: ["/home/me/projects", "/tmp/work"] },
    })
  })

  it("rejects filesystem roots and system directories before saving writable roots", async () => {
    renderCard()
    const roots = screen.getByTestId("sandbox-policy-writable-roots")

    fireEvent.change(roots, { target: { value: "/, /usr" } })
    fireEvent.blur(roots)

    expect(mockSave).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be used as a writable root/)
  })

  it("rejects Cognia app-data directories before saving writable roots", async () => {
    renderCard()
    const roots = screen.getByTestId("sandbox-policy-writable-roots")

    fireEvent.change(roots, {
      target: { value: "C:\\Users\\me\\AppData\\Roaming\\cognia" },
    })
    fireEvent.blur(roots)

    expect(mockSave).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be used as a writable root/)
  })
})
