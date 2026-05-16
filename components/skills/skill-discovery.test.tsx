/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/claude/ipc", () => ({
  skillsScanDir: jest.fn(async () => []),
  skillsScanNative: jest.fn(async () => []),
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: jest.fn(async () => null),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

import { render, screen } from "@testing-library/react"
import { SkillDiscovery } from "./skill-discovery"

describe("SkillDiscovery", () => {
  it("renders the localized path label without a concatenated prefix", () => {
    render(<SkillDiscovery />)
    expect(screen.getByText("pathLabelFull")).toBeInTheDocument()
    // The old "toolbar.import — pathLabel" concat is gone.
    expect(screen.queryByText(/toolbar\.import.*pathLabel/)).not.toBeInTheDocument()
  })

  it("uses a localized placeholder on the path input", () => {
    render(<SkillDiscovery />)
    expect(screen.getByPlaceholderText("pathPlaceholder")).toBeInTheDocument()
  })

  it("disables scan buttons in non-desktop mode", () => {
    render(<SkillDiscovery />)
    expect(screen.getByText("scanHome").closest("button")).toBeDisabled()
    expect(screen.getByText("scanCustom").closest("button")).toBeDisabled()
  })
})
