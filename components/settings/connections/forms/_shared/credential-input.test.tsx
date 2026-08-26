/**
 * @jest-environment jsdom
 */
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
      return (key: string) => {
        const path = prefix ? `${prefix}.${key}` : key
        let cursor: unknown = en
        for (const seg of path.split(".")) {
          if (!cursor || typeof cursor !== "object" || !(seg in (cursor as object))) {
            throw new Error(`missing en key: settings.connections.${path}`)
          }
          cursor = (cursor as Record<string, unknown>)[seg]
        }
        if (typeof cursor !== "string") throw new Error(`not a string: ${path}`)
        return cursor
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
    fireEvent.click(screen.getByLabelText("Show the secret"))
    expect((document.getElementById("cred") as HTMLInputElement).type).toBe("text")
    fireEvent.click(screen.getByLabelText("Hide the secret"))
    expect((document.getElementById("cred") as HTMLInputElement).type).toBe("password")
  })

  it("disables the reveal toggle when there is nothing to reveal", () => {
    renderInput({ value: "", status: "unset" })
    expect(screen.getByLabelText("Show the secret")).toBeDisabled()
  })

  it("disables the reveal toggle and the input while loading", () => {
    renderInput({ value: "anything", status: "loading" })
    expect(screen.getByLabelText("Show the secret")).toBeDisabled()
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
    expect(screen.queryByLabelText("Show the secret")).not.toBeInTheDocument()
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
