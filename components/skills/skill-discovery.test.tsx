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
  skillsScanCodex: jest.fn(async () => []),
  skillsScanOpencode: jest.fn(async () => []),
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: jest.fn(async () => null),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { SkillDiscovery } from "./skill-discovery"
import { skillsScanCodex, skillsScanOpencode } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"

describe("SkillDiscovery", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(isTauri as jest.Mock).mockReturnValue(false)
  })

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
    expect(screen.getByText("scanCodex").closest("button")).toBeDisabled()
    expect(screen.getByText("scanOpencode").closest("button")).toBeDisabled()
    expect(screen.getByText("scanCustom").closest("button")).toBeDisabled()
  })

  it("scans the global Codex skills dir (~/.agents/skills) on desktop", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    render(<SkillDiscovery />)
    fireEvent.click(screen.getByText("scanCodex").closest("button")!)
    await waitFor(() => expect(skillsScanCodex).toHaveBeenCalledTimes(1))
  })

  it("scans the resolved global OpenCode skills directory on desktop", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    render(<SkillDiscovery />)
    fireEvent.click(screen.getByText("scanOpencode").closest("button")!)
    await waitFor(() => expect(skillsScanOpencode).toHaveBeenCalledTimes(1))
  })
})
