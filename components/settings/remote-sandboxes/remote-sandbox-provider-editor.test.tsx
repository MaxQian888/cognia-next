import { act, fireEvent, render, screen, within } from "@testing-library/react"

import en from "@/i18n/messages/en/settings/remoteSandboxes.json"
import type { RemoteSandboxesWriteResult } from "@/hooks/sandbox/use-remote-sandboxes"
import type { ProviderDraft } from "@/lib/sandbox/remote-sandbox-draft"
import type { SandboxProviderConfig } from "@/types/sandbox/remote-sandboxes"
import {
  RemoteSandboxProviderEditor,
  type RemoteSandboxProviderEditorProps,
} from "./remote-sandbox-provider-editor"

const t = en.editor

const cluster: SandboxProviderConfig = {
  id: "cluster",
  kind: "kubernetes",
  label: "Prod cluster",
  credential: { secretId: "remote-sandbox:cluster" },
  limits: { maxConcurrent: 4, maxLifetimeSecs: 7200, idleTimeoutSecs: 600 },
  settings: { connection: "kubeconfig", namespace: "cognia", egress: "network-policy" },
}

function renderEditor(
  props: Partial<RemoteSandboxProviderEditorProps> = {},
  result: RemoteSandboxesWriteResult = { ok: true }
) {
  const save = jest.fn(async (_draft: ProviderDraft, _editingId?: string) => result)
  const onOpenChange = jest.fn()
  render(
    <RemoteSandboxProviderEditor
      open
      onOpenChange={onOpenChange}
      existingIds={[]}
      storedSecretIds={[]}
      busy={false}
      save={save}
      {...props}
    />
  )
  return { save, onOpenChange }
}

const dialog = () => screen.getByTestId("remote-sandbox-editor")
const saveButton = () => within(dialog()).getByRole("button", { name: t.save })

describe("RemoteSandboxProviderEditor", () => {
  it("adds an E2B provider with its key", async () => {
    const { save, onOpenChange } = renderEditor()
    expect(screen.getByText(t.createTitle)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(t.id), { target: { value: "e2b" } })
    fireEvent.change(screen.getByLabelText(t.credential.e2b), { target: { value: "e2b_key" } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(save).toHaveBeenCalledTimes(1)
    const [draft, editingId] = save.mock.calls[0]!
    expect(draft).toMatchObject({ kind: "e2b", id: "e2b", credential: "e2b_key" })
    expect(editingId).toBeUndefined()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("names every problem once a save is tried, and does not save", async () => {
    const { save } = renderEditor()
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(save).not.toHaveBeenCalled()
    const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent)
    expect(alerts).toEqual(
      expect.arrayContaining([t.problem.id_invalid, t.problem.credential_required])
    )
    expect(saveButton()).toBeDisabled()
  })

  it("shows a field's problem as soon as it is typed into", () => {
    renderEditor({ existingIds: ["taken"] })
    fireEvent.change(screen.getByLabelText(t.id), { target: { value: "taken" } })
    expect(screen.getByRole("alert")).toHaveTextContent(t.problem.id_taken)
  })

  it("edits a Kubernetes provider keeping its stored kubeconfig", async () => {
    const { save } = renderEditor({
      existing: cluster,
      existingIds: ["cluster"],
      storedSecretIds: ["remote-sandbox:cluster"],
    })
    expect(screen.getByText(t.editTitle.replace("{label}", "Prod cluster"))).toBeInTheDocument()
    expect(screen.getByText(t.credential.keep)).toBeInTheDocument()
    expect(screen.getByLabelText(t.kubernetes.namespace)).toHaveValue("cognia")
    // The kind is fixed once a provider exists.
    expect(screen.getByLabelText(t.kind)).toBeDisabled()
    fireEvent.change(screen.getByLabelText(t.kubernetes.namespace), {
      target: { value: "sandboxes" },
    })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    const [draft, editingId] = save.mock.calls[0]!
    expect(editingId).toBe("cluster")
    expect(draft.credential).toBe("")
    expect(draft.kubernetes.namespace).toBe("sandboxes")
  })

  it("says a NetworkPolicy allowlist is recorded and not enforced", () => {
    renderEditor({ existing: cluster, existingIds: ["cluster"] })
    const hint = screen.getByTestId("remote-sandbox-egress-hint")
    expect(hint).toHaveTextContent(t.kubernetes.egressHint["network-policy"])
    expect(hint).toHaveAttribute("data-dormant", "egress-allowlist")
  })

  it("does not label Cilium egress as dormant", () => {
    renderEditor({
      existing: { ...cluster, settings: { ...cluster.settings, egress: "cilium" } },
      existingIds: ["cluster"],
    })
    const hint = screen.getByTestId("remote-sandbox-egress-hint")
    expect(hint).toHaveTextContent(t.kubernetes.egressHint.cilium)
    expect(hint).not.toHaveAttribute("data-dormant")
  })

  it("names where a hand-written credential is read from", () => {
    renderEditor({
      existing: { ...cluster, credential: { env: "KUBECONFIG_YAML" } },
      existingIds: ["cluster"],
    })
    expect(
      screen.getByText(t.credential.keepSource.replace("{source}", "KUBECONFIG_YAML"))
    ).toBeInTheDocument()
  })

  it("shows the Host's refusal and stays open", async () => {
    const { onOpenChange } = renderEditor(
      {},
      { ok: false, problem: { code: "remote_sandboxes_invalid", message: "e2b: bad" } }
    )
    fireEvent.change(screen.getByLabelText(t.id), { target: { value: "e2b" } })
    fireEvent.change(screen.getByLabelText(t.credential.e2b), { target: { value: "k" } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    expect(screen.getByRole("alert")).toHaveTextContent(
      en.errors.remote_sandboxes_invalid.replace("{message}", "e2b: bad")
    )
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("renders nothing while closed", () => {
    renderEditor({ open: false })
    expect(screen.queryByTestId("remote-sandbox-editor")).not.toBeInTheDocument()
  })
})
