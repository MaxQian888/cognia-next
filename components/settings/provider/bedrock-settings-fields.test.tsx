import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren, ReactNode } from "react"
import type { BedrockConnectionSettings } from "@cognia/provider-types"

import { BedrockSettingsFields } from "./bedrock-settings-fields"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <div>
      <button type="button" onClick={() => onValueChange(value === "api-key" ? "iam" : value)}>
        change-auth-mode
      </button>
      {children}
    </div>
  ),
  SelectContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SelectItem: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SelectTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SelectValue: () => null,
}))

describe("BedrockSettingsFields", () => {
  it("shows mode-specific API-key fields and reports missing region", () => {
    render(
      <BedrockSettingsFields
        value={{ authMode: "api-key", apiKey: "bedrock-key", region: "" }}
        onChange={jest.fn()}
      />
    )

    expect(screen.getByLabelText("configTab.bedrockApiKey")).toHaveAttribute("type", "password")
    expect(screen.getByText("configTab.bedrockRegionRequired")).toBeInTheDocument()
    expect(screen.queryByLabelText("configTab.bedrockAccessKeyId")).not.toBeInTheDocument()
  })

  it("preserves all fields when switching auth mode so credentials are not lost", () => {
    const onChange = jest.fn()
    render(
      <BedrockSettingsFields
        value={{ authMode: "api-key", region: "us-east-1", apiKey: "secret" }}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "change-auth-mode" }))
    expect(onChange).toHaveBeenCalledWith({
      authMode: "iam",
      region: "us-east-1",
      apiKey: "secret",
    })
  })

  it("updates IAM fields without exposing the secret as plain text", () => {
    const onChange = jest.fn()
    render(
      <BedrockSettingsFields value={{ authMode: "iam", region: "us-east-1" }} onChange={onChange} />
    )

    fireEvent.change(screen.getByLabelText("configTab.bedrockAccessKeyId"), {
      target: { value: "AKIAEXAMPLE" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "iam", accessKeyId: "AKIAEXAMPLE" })
    )
    expect(screen.getByLabelText("configTab.bedrockSecretAccessKey")).toHaveAttribute(
      "type",
      "password"
    )
  })

  it("renders default-chain fields and updates optional profile/role/session values", () => {
    const onChange = jest.fn()
    render(
      <BedrockSettingsFields
        value={{ authMode: "default-chain", region: "us-east-1" }}
        onChange={onChange}
      />
    )

    expect(screen.getByLabelText("configTab.bedrockProfile")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("configTab.bedrockProfile"), {
      target: { value: "prod" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "default-chain", profile: "prod" })
    )
    fireEvent.change(screen.getByLabelText("configTab.bedrockRoleArn"), {
      target: { value: "arn:aws:iam::123:role/X" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "default-chain", roleArn: "arn:aws:iam::123:role/X" })
    )
    fireEvent.change(screen.getByLabelText("configTab.bedrockRoleSessionName"), {
      target: { value: "session" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "default-chain", roleSessionName: "session" })
    )
  })

  it("updates region, base URL and API key fields in api-key mode", () => {
    const onChange = jest.fn()
    render(
      <BedrockSettingsFields
        value={{ authMode: "api-key", region: "us-east-1", apiKey: "secret" }}
        onChange={onChange}
      />
    )

    fireEvent.change(screen.getByLabelText("configTab.bedrockRegion"), {
      target: { value: "us-west-2" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "api-key", region: "us-west-2" })
    )
    fireEvent.change(screen.getByLabelText("configTab.bedrockBaseURL"), {
      target: { value: "https://bedrock.example.com" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "api-key", baseURL: "https://bedrock.example.com" })
    )
    fireEvent.change(screen.getByLabelText("configTab.bedrockApiKey"), {
      target: { value: "new-secret" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "api-key", apiKey: "new-secret" })
    )
  })

  it("shows the API key required message when the key is missing", () => {
    render(
      <BedrockSettingsFields
        value={{ authMode: "api-key", region: "us-east-1", apiKey: "" }}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByText("configTab.bedrockApiKeyRequired")).toBeInTheDocument()
  })

  it("updates IAM secret and session token fields", () => {
    const onChange = jest.fn()
    render(
      <BedrockSettingsFields value={{ authMode: "iam", region: "us-east-1" }} onChange={onChange} />
    )

    fireEvent.change(screen.getByLabelText("configTab.bedrockSecretAccessKey"), {
      target: { value: "secret" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "iam", secretAccessKey: "secret" })
    )
    fireEvent.change(screen.getByLabelText("configTab.bedrockSessionToken"), {
      target: { value: "token" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "iam", sessionToken: "token" })
    )
  })

  it("handles undefined region and apiKey values", () => {
    const onChange = jest.fn()
    render(
      <BedrockSettingsFields
        value={{ authMode: "api-key" } as unknown as BedrockConnectionSettings}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText("configTab.bedrockRegion"), {
      target: { value: "eu-west-1" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "api-key", region: "eu-west-1" })
    )
  })
})
