import { fireEvent, render, screen } from "@testing-library/react"
import type { PropsWithChildren, ReactNode } from "react"

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
})
