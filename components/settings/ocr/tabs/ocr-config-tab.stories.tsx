import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { OcrConfigTab } from "./ocr-config-tab"

// Pure, props-only credential form. Input set is derived from `credentialKeys`;
// `reusesMainProviderKey` swaps inputs for an info alert; `shells` drives the
// shell-support pills shown for credential-less local providers.
const meta = {
  title: "Settings/Ocr/Tabs/OcrConfigTab",
  component: OcrConfigTab,
  args: {
    providerId: "mistral-ocr",
    credentialKeys: ["apiKey"],
    shells: { browser: true, tauri: true, capacitor: true },
    credentials: {},
    onCredentialChange: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof OcrConfigTab>

export default meta
type Story = StoryObj<typeof meta>

// Single API-key provider.
export const SingleKey: Story = {}

// AWS Textract: three credential fields.
export const AwsTextract: Story = {
  args: {
    providerId: "aws-textract",
    credentialKeys: ["accessKeyId", "secretAccessKey", "sessionToken"],
  },
}

// Vision provider that reuses the main provider key → info alert, no inputs.
export const ReusesMainKey: Story = {
  args: {
    providerId: "anthropic-vision",
    credentialKeys: [],
    reusesMainProviderKey: true,
  },
}

// Credential-less local provider → shell-support pills (Tauri-only here).
export const ShellPills: Story = {
  args: {
    providerId: "tesseract-native",
    credentialKeys: [],
    shells: { browser: false, tauri: true, capacitor: false },
  },
}

// Probe button rendered (credentials present + onProbe supplied).
export const Probeable: Story = {
  args: { credentials: { apiKey: "sk-demo" }, onProbe: fn() },
}

// Successful probe result alert.
export const ProbeSuccess: Story = {
  args: {
    credentials: { apiKey: "sk-demo" },
    onProbe: fn(),
    probeOutcome: { ok: true, durationMs: 123.6 },
  },
}

// Failed probe result alert.
export const ProbeFailure: Story = {
  args: {
    credentials: {},
    onProbe: fn(),
    probeOutcome: {
      ok: false,
      durationMs: 50,
      error: { code: "missing_credentials", message: "No API key configured." },
    },
  },
}

// Probe in flight → button disabled with running label.
export const Probing: Story = {
  args: { credentials: { apiKey: "sk-demo" }, onProbe: fn(), isProbing: true },
}
