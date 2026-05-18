import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrConfigTab } from "./ocr-config-tab"
import type { ProbeOutcome } from "@/lib/ocr/probe"

const SHELLS_ALL = { browser: true, tauri: true, capacitor: true }
const SHELLS_TAURI_ONLY = { browser: false, tauri: true, capacitor: false }

describe("OcrConfigTab", () => {
  it("renders a single password input for mistral-ocr (apiKey)", () => {
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
      />
    )
    expect(screen.getByLabelText(/API key/i)).toBeInTheDocument()
  })

  it("renders three inputs for aws-textract (accessKeyId, secretAccessKey, sessionToken)", () => {
    render(
      <OcrConfigTab
        providerId="aws-textract"
        credentialKeys={["accessKeyId", "secretAccessKey", "sessionToken"]}
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
      />
    )
    expect(screen.getByLabelText(/AWS access key ID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/AWS secret access key/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/AWS session token/i)).toBeInTheDocument()
  })

  it("shows the reuses-main-key alert and no inputs for anthropic-vision", () => {
    render(
      <OcrConfigTab
        providerId="anthropic-vision"
        credentialKeys={[]}
        reusesMainProviderKey
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
      />
    )
    expect(screen.getByTestId("ocr-reuses-main-key")).toBeInTheDocument()
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument()
  })

  it("shows shell pills for local providers without credentials", () => {
    render(
      <OcrConfigTab
        providerId="tesseract-native"
        credentialKeys={[]}
        shells={SHELLS_TAURI_ONLY}
        credentials={{}}
        onCredentialChange={() => {}}
      />
    )
    const pillsBlock = screen.getByTestId("ocr-shell-pills")
    expect(pillsBlock).toHaveTextContent(/Desktop/i)
    expect(pillsBlock).not.toHaveTextContent(/Mobile/i)
    expect(pillsBlock).not.toHaveTextContent(/Browser/i)
  })

  it("toggles the show/hide eye button for a credential input", async () => {
    const user = userEvent.setup()
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{ apiKey: "sk-abc" }}
        onCredentialChange={() => {}}
      />
    )
    const input = screen.getByLabelText(/API key/i) as HTMLInputElement
    expect(input.type).toBe("password")
    await user.click(screen.getByRole("button", { name: /Show/i }))
    expect(input.type).toBe("text")
    await user.click(screen.getByRole("button", { name: /Hide/i }))
    expect(input.type).toBe("password")
  })

  it("calls onCredentialChange with the new value", async () => {
    const user = userEvent.setup()
    const onCredentialChange = jest.fn()
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={onCredentialChange}
      />
    )
    const input = screen.getByLabelText(/API key/i)
    await user.type(input, "sk-X")
    expect(onCredentialChange).toHaveBeenCalled()
    expect(onCredentialChange.mock.calls.at(-1)![0]).toBe("apiKey")
  })

  it("does not render the probe button when onProbe is omitted", () => {
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
      />
    )
    expect(screen.queryByTestId("ocr-probe-button")).not.toBeInTheDocument()
  })

  it("renders the probe button when onProbe is supplied and credentials exist", async () => {
    const user = userEvent.setup()
    const onProbe = jest.fn()
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{ apiKey: "x" }}
        onCredentialChange={() => {}}
        onProbe={onProbe}
      />
    )
    await user.click(screen.getByTestId("ocr-probe-button"))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it("renders the probe button for reuses-main-key providers", () => {
    render(
      <OcrConfigTab
        providerId="anthropic-vision"
        credentialKeys={[]}
        reusesMainProviderKey
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
        onProbe={() => {}}
      />
    )
    expect(screen.getByTestId("ocr-probe-button")).toBeInTheDocument()
  })

  it("does not render the probe button for credential-less local providers", () => {
    render(
      <OcrConfigTab
        providerId="tesseract-native"
        credentialKeys={[]}
        shells={SHELLS_TAURI_ONLY}
        credentials={{}}
        onCredentialChange={() => {}}
        onProbe={() => {}}
      />
    )
    expect(screen.queryByTestId("ocr-probe-button")).not.toBeInTheDocument()
  })

  it("renders a success probe alert with latency", () => {
    const outcome: ProbeOutcome = { ok: true, durationMs: 123.6 }
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{ apiKey: "x" }}
        onCredentialChange={() => {}}
        onProbe={() => {}}
        probeOutcome={outcome}
      />
    )
    const alert = screen.getByTestId("ocr-probe-alert")
    expect(alert).toHaveTextContent(/124/) // rounded
  })

  it("renders a failure probe alert with the error message", () => {
    const outcome: ProbeOutcome = {
      ok: false,
      durationMs: 50,
      error: { code: "missing_credentials", message: "no key" },
    }
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
        onProbe={() => {}}
        probeOutcome={outcome}
      />
    )
    const alert = screen.getByTestId("ocr-probe-alert")
    expect(alert).toHaveTextContent(/no key/i)
  })

  it("disables the probe button when isProbing is true", () => {
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{ apiKey: "x" }}
        onCredentialChange={() => {}}
        onProbe={() => {}}
        isProbing
      />
    )
    expect(screen.getByTestId("ocr-probe-button")).toBeDisabled()
  })

  it("renders the optional description text", () => {
    render(
      <OcrConfigTab
        providerId="mistral-ocr"
        credentialKeys={["apiKey"]}
        shells={SHELLS_ALL}
        credentials={{}}
        onCredentialChange={() => {}}
        description="Markdown-first OCR."
      />
    )
    expect(screen.getByText(/Markdown-first OCR/)).toBeInTheDocument()
  })
})
