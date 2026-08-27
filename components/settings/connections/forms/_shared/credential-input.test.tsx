/**
 * @jest-environment jsdom
 */
const mockConsentCode = jest.fn(() => null as string | null)
jest.mock("@/lib/connectors/credential-lease", () => ({
  PENDING_NO_CODE: "pending",
  credentialConsentCode: () => mockConsentCode(),
}))

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen, fireEvent } from "@testing-library/react"

// The global next-intl mock in jest.setup.ts resolves against the GENERATED
// aggregate `i18n/messages/en.json`, which lags the split sources whenever a
// peer adds keys without rebuilding. Resolve against the split source
// directly, and throw on a miss, so this suite doubles as catalogue coverage
// for every key the component reads.
jest.mock("next-intl", () => {
  const load = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        join(process.cwd(), "i18n/messages", locale, "settings/connections.json"),
        "utf8"
      )
    )
  const en = load("en")
  return {
    useTranslations: (namespace?: string) => {
      const prefix = (namespace ?? "").replace(/^settings\.connections\.?/, "")
      return (key: string, values?: Record<string, unknown>) => {
        const path = prefix ? `${prefix}.${key}` : key
        let cursor: unknown = en
        for (const seg of path.split(".")) {
          if (!cursor || typeof cursor !== "object" || !(seg in (cursor as object))) {
            throw new Error(`missing en key: settings.connections.${path}`)
          }
          cursor = (cursor as Record<string, unknown>)[seg]
        }
        if (typeof cursor !== "string") throw new Error(`not a string: ${path}`)
        // Substituting is the point of a placeholder: a translator that
        // returned `{code}` verbatim would let a message ship with an argument
        // nobody passes and still look correct in this suite.
        return Object.entries(values ?? {}).reduce(
          (acc, [name, value]) =>
            acc.replace(new RegExp(`\\{\\s*${name}\\s*\\}`, "g"), String(value)),
          cursor as string
        )
      }
    },
  }
})

import { CredentialInput, type CredentialFieldStatus } from "./credential-input"

function renderInput(props: Partial<React.ComponentProps<typeof CredentialInput>> = {}) {
  const onChange = jest.fn()
  const utils = render(
    <CredentialInput id="cred" value="" onChange={onChange} status="new" {...props} />
  )
  return { onChange, ...utils }
}

const catalogue = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(process.cwd(), "i18n/messages", locale, "settings/connections.json"), "utf8")
  )

describe("CredentialInput", () => {
  it("masks the value and reveals it on demand", () => {
    renderInput({ value: "s3cret", status: "loaded" })
    expect((document.getElementById("cred") as HTMLInputElement).type).toBe("password")
    fireEvent.click(screen.getByLabelText("Reveal value"))
    expect((document.getElementById("cred") as HTMLInputElement).type).toBe("text")
    fireEvent.click(screen.getByLabelText("Hide value"))
    expect((document.getElementById("cred") as HTMLInputElement).type).toBe("password")
  })

  it("disables the reveal toggle when there is nothing to reveal", () => {
    renderInput({ value: "", status: "unset" })
    expect(screen.getByLabelText("Reveal value")).toBeDisabled()
  })

  it("disables the reveal toggle and the input while loading", () => {
    renderInput({ value: "anything", status: "loading" })
    expect(screen.getByLabelText("Reveal value")).toBeDisabled()
    expect(document.getElementById("cred")).toBeDisabled()
  })

  it("reports typing to the caller", () => {
    const { onChange } = renderInput({ status: "new" })
    fireEvent.change(document.getElementById("cred")!, { target: { value: "abc" } })
    expect(onChange).toHaveBeenCalledWith("abc")
  })

  it("keeps the create dialog quiet — `new` shows no visible status", () => {
    renderInput({ status: "new" })
    const status = document.getElementById("cred-status")!
    expect(status.className).toContain("sr-only")
  })

  it.each<[CredentialFieldStatus, string]>([
    ["loading", "Reading the saved value…"],
    ["loaded", "Saved — showing the stored value."],
    ["unset", "Not set."],
    ["stored", "Saved on the host. It cannot be shown here; type a new value to replace it."],
    ["error", "Could not read the saved value."],
  ])("explains the %s state", (status, text) => {
    renderInput({ status, value: status === "loaded" ? "v" : "" })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it("prefers a caller-supplied reason over the generic stored line", () => {
    renderInput({ status: "stored", unavailableReason: "Approve on the host to view it." })
    expect(screen.getByText("Approve on the host to view it.")).toBeInTheDocument()
    expect(screen.queryByText(/cannot be shown here/)).not.toBeInTheDocument()
  })

  it("offers a retry only when the caller can handle one", () => {
    const onRetry = jest.fn()
    const { unmount } = renderInput({ status: "error", onRetry })
    fireEvent.click(screen.getByText("Retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
    unmount()

    renderInput({ status: "error" })
    expect(screen.queryByText("Retry")).not.toBeInTheDocument()
  })

  it("offers an unlock on a stored value the host could still be asked for", () => {
    // ADR-0152 made "cannot be shown here" one consent away on a companion
    // shell. Without this the state was a dead end whose only offer was to
    // overwrite a working credential blind.
    const onRetry = jest.fn()
    const { unmount } = renderInput({ status: "stored", onRetry })

    fireEvent.click(screen.getByText("Unlock"))
    expect(onRetry).toHaveBeenCalledTimes(1)
    unmount()

    renderInput({ status: "stored" })
    expect(screen.queryByText("Unlock")).not.toBeInTheDocument()
  })

  it("keeps the unlock and the retry distinct", () => {
    // Same handler, different promises: one re-runs a call that errored, the
    // other asks a host for permission it has not granted.
    const { unmount } = renderInput({ status: "stored", onRetry: jest.fn() })
    expect(screen.queryByText("Retry")).not.toBeInTheDocument()
    unmount()

    renderInput({ status: "error", onRetry: jest.fn() })
    expect(screen.queryByText("Unlock")).not.toBeInTheDocument()
  })

  it("does not offer an unlock while the field is disabled", () => {
    renderInput({ status: "stored", onRetry: jest.fn(), disabled: true })
    expect(screen.getByText("Unlock").closest("button")).toBeDisabled()
  })

  it("swaps the placeholder for the states where the caller's hint would lie", () => {
    const { unmount } = renderInput({ status: "new", placeholder: "paste the app secret" })
    expect(document.getElementById("cred")).toHaveAttribute("placeholder", "paste the app secret")
    unmount()

    const stored = render(
      <CredentialInput
        id="s"
        value=""
        onChange={() => {}}
        status="stored"
        placeholder="paste the app secret"
      />
    )
    expect(document.getElementById("s")).toHaveAttribute(
      "placeholder",
      "Saved — leave blank to keep it"
    )
    stored.unmount()
  })

  it("renders an identifier unmasked and without a reveal toggle", () => {
    render(
      <CredentialInput
        id="ident"
        value="app-key-1"
        onChange={() => {}}
        status="loaded"
        sensitive={false}
      />
    )
    expect((document.getElementById("ident") as HTMLInputElement).type).toBe("text")
    expect(screen.queryByLabelText("Reveal value")).not.toBeInTheDocument()
    // The status line is the point of the component and survives unmasking.
    expect(screen.getByText("Saved — showing the stored value.")).toBeInTheDocument()
  })

  it("renders caller-supplied trailing content in the field row", () => {
    renderInput({ trailing: <button type="button">Test</button> })
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument()
  })

  it("ties the status line to the input for screen readers", () => {
    renderInput({ status: "unset" })
    expect(document.getElementById("cred")).toHaveAttribute("aria-describedby", "cred-status")
  })

  // Catalogue coverage: `lint:i18n` cannot see these because the component
  // reads them through a namespaced translator, so pin them here.
  it("has every key it reads in BOTH locales", () => {
    const source = readFileSync(
      join(process.cwd(), "components/settings/connections/forms/_shared/credential-input.tsx"),
      "utf8"
    )
    const used = [...source.matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)

    for (const locale of ["en", "zh-CN"]) {
      const block = catalogue(locale).credentialField as Record<string, unknown> | undefined
      expect(block).toBeDefined()
      for (const key of used) {
        expect(typeof block![key]).toBe("string")
      }
    }
  })
})

describe("awaiting a host approval", () => {
  beforeEach(() => mockConsentCode.mockReturnValue(null))

  it("says the host is waiting, and names the code a console approver needs", () => {
    mockConsentCode.mockReturnValue("A1B2C3D4")
    renderInput({ status: "awaiting-consent", onRetry: jest.fn() })

    expect(screen.getByText(/Waiting for approval on the host/)).toBeInTheDocument()
    expect(screen.getByText(/A1B2C3D4/)).toBeInTheDocument()
  })

  it("drops the code when the host named none rather than printing a placeholder", () => {
    mockConsentCode.mockReturnValue("pending")
    renderInput({ status: "awaiting-consent" })

    expect(screen.getByText("Waiting for approval on the host.")).toBeInTheDocument()
  })

  it("offers a retry, because the answer arrives out of band", () => {
    const onRetry = jest.fn()
    renderInput({ status: "awaiting-consent", onRetry })
    fireEvent.click(screen.getByText("Retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("keeps the stored placeholder so an empty box still means keep", () => {
    renderInput({ status: "awaiting-consent", placeholder: "paste the app secret" })
    expect(document.getElementById("cred")).toHaveAttribute(
      "placeholder",
      "Saved — leave blank to keep it"
    )
  })
})
