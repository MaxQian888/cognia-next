/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/hooks/plugins/use-permission-description", () => ({
  usePermissionDescription: () => (p: string) => p,
}))
const requestGrant = jest.fn(async (..._a: unknown[]) => null)
jest.mock("@/hooks/plugins/use-wasm-capability-grant", () => ({
  useWasmCapabilityGrant: () => ({ requestGrant, sheet: null, cancel: jest.fn() }),
}))
const planCogpackImport = jest.fn()
const applyCogpackImport = jest.fn()
jest.mock("@/lib/plugin/cogpack/import", () => ({
  planCogpackImport: (...a: unknown[]) => planCogpackImport(...a),
  applyCogpackImport: (...a: unknown[]) => applyCogpackImport(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() } }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { CogpackImportDialog } from "./cogpack-import-dialog"

const { toast } = jest.requireMock("sonner") as {
  toast: { success: jest.Mock; warning: jest.Mock; error: jest.Mock }
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    inspected: {
      manifest: {
        id: "deep-writer",
        version: "2.0.0",
        name: "Deep writer",
        description: "Long form",
        members: [],
      },
      fingerprint: "f",
    },
    trust: { trust: "signed-unknown", fingerprint: "abcdef0123456789ff" },
    compatibility: { minHostVersion: "0.5.0", hostVersion: "0.4.0", satisfied: false },
    members: [
      {
        member: { id: "gh", name: "GH", version: "2.0.0", optional: false },
        status: "different-version",
        installedVersion: "1.0.0",
        installByDefault: true,
        install: jest.fn(),
        permissions: ["network:fetch"],
        optionalPermissions: [],
        missingBinaries: [{ name: "rg" }],
        conflicts: [{ severity: "medium", message: "command:clash" }],
        secretFields: ["token"],
        reviewAfterInstall: false,
      },
      {
        member: { id: "shipped", name: "Shipped", version: "1.0.0", optional: true },
        status: "unavailable",
        unavailable: { reason: "builtin-missing" },
        installByDefault: false,
        permissions: [],
        optionalPermissions: [],
        missingBinaries: [],
        conflicts: [],
        secretFields: [],
        reviewAfterInstall: false,
      },
    ],
    missingDependencies: [{ pluginId: "gh", dependencyId: "docs", constraint: "^1.0.0" }],
    disabledOnActivation: ["games"],
    ...overrides,
  }
}

const file = { name: "deep-writer-2.0.0.cogpack", bytes: new Uint8Array([1]) }

beforeEach(() => jest.clearAllMocks())

describe("CogpackImportDialog", () => {
  it("reviews trust, compatibility, members, dependencies and what turns off, then imports", async () => {
    planCogpackImport.mockResolvedValue(plan())
    applyCogpackImport.mockResolvedValue({
      installId: "i",
      cogsetId: "c",
      installed: ["gh"],
      failed: [],
      missing: [{ pluginId: "shipped", reason: "builtin-missing" }],
      grantsToReview: [{ manifest: { id: "w", type: "wasm" } }],
    })
    const onSwitch = jest.fn()
    render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => `n:${id}`}
        onSwitch={onSwitch}
      />
    )
    await waitFor(() => expect(screen.getByText("trust.signed-unknown")).toBeTruthy())
    expect(screen.getByText('compatibility:{"required":"0.5.0","current":"0.4.0"}')).toBeTruthy()
    expect(
      screen.getByText('status.different-version:{"installed":"1.0.0","version":"2.0.0"}')
    ).toBeTruthy()
    expect(screen.getByText("unavailable.builtin-missing")).toBeTruthy()
    expect(screen.getByText('missingBinaries:{"names":"rg"}')).toBeTruthy()
    expect(screen.getByText("command:clash")).toBeTruthy()
    expect(
      screen.getByText('dependency:{"plugin":"n:gh","dependency":"docs","constraint":"^1.0.0"}')
    ).toBeTruthy()
    expect(screen.getByText('disabledOnActivation:{"names":"n:games"}')).toBeTruthy()

    fireEvent.change(screen.getByLabelText("token"), { target: { value: "s3cret" } })
    fireEvent.click(screen.getByText("trustSigner"))
    fireEvent.click(screen.getByTestId("cogpack-import-submit"))
    await waitFor(() => expect(screen.getByTestId("cogpack-import-missing")).toBeTruthy())
    const choices = applyCogpackImport.mock.calls[0][1]
    expect([...choices.install]).toEqual(["gh"])
    expect(choices.secrets).toEqual({ gh: { token: "s3cret" } })
    expect(choices.trustSigner).toBe(true)
    expect(choices.mode).toBe("new")
    expect(requestGrant).toHaveBeenCalledWith({
      manifest: { id: "w", type: "wasm" },
      authorFingerprint: undefined,
    })
    expect(toast.warning).toHaveBeenCalledWith('doneWithMissing:{"name":"Deep writer","count":1}')
    fireEvent.click(screen.getByTestId("cogpack-import-switch"))
    expect(onSwitch).toHaveBeenCalledWith("c")
  })

  it("keeps the installed version when the user unticks the pinned install", async () => {
    planCogpackImport.mockResolvedValue(plan())
    applyCogpackImport.mockResolvedValue({
      installId: "i",
      cogsetId: "c",
      installed: [],
      failed: [],
      missing: [],
      grantsToReview: [],
    })
    render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText('installPinned:{"version":"2.0.0"}')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('installPinned:{"version":"2.0.0"}'))
    fireEvent.click(screen.getByTestId("cogpack-import-submit"))
    await waitFor(() => expect(applyCogpackImport).toHaveBeenCalled())
    expect([...applyCogpackImport.mock.calls[0][1].install]).toEqual([])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('done:{"name":"Deep writer"}'))
  })

  it("blocks what the policy refuses", async () => {
    planCogpackImport.mockResolvedValue(
      plan({ trust: { trust: "unsigned", refusedBy: "signature-required" } })
    )
    render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText("refused.signature-required")).toBeTruthy())
    expect((screen.getByTestId("cogpack-import-submit") as HTMLButtonElement).disabled).toBe(true)
  })

  it("offers to update an earlier import, with per-plugin choices", async () => {
    planCogpackImport.mockResolvedValue(
      plan({
        update: {
          cogset: { id: "c1", name: "My writer" },
          install: {},
          entries: [
            {
              pluginId: "gh",
              change: "repinned",
              previous: { version: "1.0.0" },
              next: { version: "2.0.0" },
              localEdited: true,
            },
            { pluginId: "same", change: "unchanged", localEdited: false },
          ],
        },
      })
    )
    applyCogpackImport.mockResolvedValue({
      installId: "i",
      cogsetId: "c1",
      installed: [],
      failed: [],
      missing: [],
      grantsToReview: [],
    })
    render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() => expect(screen.getByTestId("cogpack-import-update")).toBeTruthy())
    expect(screen.getByText('change.repinned:{"from":"1.0.0","to":"2.0.0"}')).toBeTruthy()
    expect(screen.queryByText(/change.unchanged/)).toBeNull()
    fireEvent.click(screen.getByText("useNext"))
    fireEvent.click(screen.getByTestId("cogpack-import-submit"))
    await waitFor(() => expect(applyCogpackImport).toHaveBeenCalled())
    const choices = applyCogpackImport.mock.calls[0][1]
    expect(choices.mode).toBe("update")
    expect([...choices.useNext]).toEqual(["gh"])
  })

  it("shows why a file could not be read, and toasts a failed import", async () => {
    planCogpackImport.mockRejectedValueOnce(new Error("Cogpack manifest is missing"))
    const { unmount } = render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Cogpack manifest is missing")
    )
    unmount()

    planCogpackImport.mockResolvedValue(plan({ trust: { trust: "trusted" } }))
    applyCogpackImport.mockRejectedValueOnce(new Error("boom"))
    render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() => expect(screen.getByTestId("cogpack-import-submit")).toBeTruthy())
    fireEvent.click(screen.getByTestId("cogpack-import-submit"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("failed", { description: "boom" }))
    expect(screen.getByTestId("cogpack-import-submit")).toBeTruthy()
  })

  it("explains a file it cannot open in translated words, with the detail below", async () => {
    const { PackageFormatError } = jest.requireActual("@/lib/packaging/archive-path")
    planCogpackImport.mockRejectedValueOnce(
      new PackageFormatError("checksum-mismatch", "Cogpack file checksum mismatch: plugins/x/a.js")
    )
    render(
      <CogpackImportDialog
        file={file}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText("invalid.checksum-mismatch")).toBeTruthy())
    expect(screen.getByText(`openFailed:{"file":"${file.name}"}`)).toBeTruthy()
    expect(screen.getByText("Cogpack file checksum mismatch: plugins/x/a.js")).toBeTruthy()

    planCogpackImport.mockRejectedValueOnce(new Error("disk on fire"))
    render(
      <CogpackImportDialog
        file={{ ...file }}
        onOpenChange={jest.fn()}
        pluginName={(id) => id}
        onSwitch={jest.fn()}
      />
    )
    await waitFor(() => expect(screen.getByText("invalid.unknown")).toBeTruthy())
  })
})
