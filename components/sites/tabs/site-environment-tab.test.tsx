import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago" }),
  useNow: () => new Date(1_700_000_000_000),
}))

// The shared KvEditor is a full ai-elements surface; swap it for a minimal
// harness honouring the same rows/onChange contract so these tests exercise the
// tab's seeding and diff logic rather than the editor's internals.
jest.mock("@/components/settings/mcp/kv-editor", () => ({
  KvEditor: ({
    label,
    rows,
    onChange,
  }: {
    label: string
    rows: { key: string; value: string }[]
    onChange: (rows: { key: string; value: string }[]) => void
  }) => (
    <div data-testid={`kv-${label}`}>
      <textarea
        data-testid={`kv-input-${label}`}
        value={rows.map((row) => `${row.key}=${row.value}`).join("\n")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [key, ...rest] = line.split("=")
                return { key, value: rest.join("=") }
              })
          )
        }
      />
    </div>
  ),
}))

import type { SiteEnvironmentRevisionRow } from "@/types/sites"
import { SiteEnvironmentTab } from "./site-environment-tab"

function revision(
  overrides: Partial<SiteEnvironmentRevisionRow> & Pick<SiteEnvironmentRevisionRow, "id">
): SiteEnvironmentRevisionRow {
  return {
    siteId: "site_1",
    sequence: 1,
    variables: {},
    secretRefs: [],
    createdAt: 1,
    ...overrides,
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-desktop" as const, title: "Desktop only" }

function renderTab(props: Partial<React.ComponentProps<typeof SiteEnvironmentTab>> = {}) {
  const onSave = jest.fn()
  render(
    <SiteEnvironmentTab
      environments={[
        revision({
          id: "e1",
          variables: { API_ORIGIN: "https://api.example.com" },
          secretRefs: [{ key: "API_TOKEN", credentialId: "c1", revision: "r1" }],
        }),
      ]}
      gate={allowed}
      isBusy={() => false}
      onSave={onSave}
      {...props}
    />
  )
  return { onSave }
}

it("offers a first revision when none exists", () => {
  renderTab({ environments: [] })
  expect(screen.getByTestId("site-environment-empty")).toBeInTheDocument()
})

it("renders the stored revision as data before offering an editor", () => {
  renderTab()
  const variables = screen.getByTestId("site-environment-variables")
  expect(variables).toHaveTextContent("API_ORIGIN")
  expect(variables).toHaveTextContent("https://api.example.com")
  expect(screen.queryByTestId("site-environment-editor")).not.toBeInTheDocument()
})

it("shows secret references without ever showing a value", () => {
  renderTab({
    environments: [
      revision({
        id: "e1",
        secretRefs: [{ key: "API_TOKEN", credentialId: "cred_8f2a", revision: "3" }],
      }),
    ],
  })
  expect(screen.getByText("API_TOKEN")).toBeInTheDocument()
  expect(screen.getByText(/cred_8f2a/)).toBeInTheDocument()
  expect(screen.getByText("environment.secretValueHidden")).toBeInTheDocument()
})

it("seeds the editor from the current revision so an untouched save is a no-op", async () => {
  const user = userEvent.setup()
  renderTab()
  await user.click(screen.getByTestId("site-environment-edit"))

  expect(screen.getByTestId("kv-input-environment.variables")).toHaveValue(
    "API_ORIGIN=https://api.example.com"
  )
  expect(screen.getByTestId("site-environment-diff")).toHaveTextContent("environment.diff.none")
})

it("shows what the save would change before writing it", async () => {
  const user = userEvent.setup()
  renderTab()
  await user.click(screen.getByTestId("site-environment-edit"))
  await user.clear(screen.getByTestId("kv-input-environment.variables"))
  await user.click(screen.getByTestId("kv-input-environment.variables"))
  await user.paste("LOG_LEVEL=info")

  const diff = screen.getByTestId("site-environment-diff")
  expect(diff).toHaveTextContent('environment.diff.added:{"count":1}')
  expect(diff).toHaveTextContent('environment.diff.removed:{"count":1}')
  // The secret half of the diff answers the question the old warning could
  // only gesture at: which of my secrets survive this save.
  expect(diff).toHaveTextContent('environment.secretDiff.kept:{"count":1}')
  expect(diff).toHaveTextContent('environment.secretDiff.removed:{"count":0}')
})

it("keeps every stored secret when only a variable changes", async () => {
  // The bug this replaces: the secrets grid opened empty, `saveEnvironment`
  // rebuilt the reference list from it, and a variable edit silently deleted
  // every configured secret from the new revision.
  const user = userEvent.setup()
  const { onSave } = renderTab()
  await user.click(screen.getByTestId("site-environment-edit"))
  await user.click(screen.getByTestId("site-environment-save"))

  expect(onSave).toHaveBeenCalledWith({
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: [{ key: "API_TOKEN", action: "keep" }],
  })
})

it("replaces one secret without touching the others", async () => {
  const user = userEvent.setup()
  const { onSave } = renderTab({
    environments: [
      revision({
        id: "e1",
        variables: { API_ORIGIN: "https://api.example.com" },
        secretRefs: [
          { key: "API_TOKEN", credentialId: "c1", revision: "r1" },
          { key: "DB_PASSWORD", credentialId: "c2", revision: "r2" },
        ],
      }),
    ],
  })
  await user.click(screen.getByTestId("site-environment-edit"))
  await user.click(screen.getByTestId("site-secret-replace-API_TOKEN"))
  await user.type(screen.getByLabelText('environment.secretAction.set:{"key":"API_TOKEN"}'), "new")
  await user.click(screen.getByTestId("site-environment-save"))

  expect(onSave).toHaveBeenCalledWith({
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: [
      { key: "API_TOKEN", action: "set", value: "new" },
      { key: "DB_PASSWORD", action: "keep" },
    ],
  })
})

it("removes a secret only when the user says so, and can undo it", async () => {
  const user = userEvent.setup()
  const { onSave } = renderTab()
  await user.click(screen.getByTestId("site-environment-edit"))
  await user.click(screen.getByTestId("site-secret-remove-API_TOKEN"))
  expect(screen.getByTestId("site-environment-diff")).toHaveTextContent(
    'environment.secretDiff.removed:{"count":1}'
  )

  await user.click(screen.getByTestId("site-secret-keep-API_TOKEN"))
  await user.click(screen.getByTestId("site-environment-save"))
  expect(onSave).toHaveBeenCalledWith({
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: [{ key: "API_TOKEN", action: "keep" }],
  })
})

it("adds a new secret", async () => {
  const user = userEvent.setup()
  const { onSave } = renderTab()
  await user.click(screen.getByTestId("site-environment-edit"))
  await user.type(screen.getByLabelText("environment.secretAction.newKey"), "NEW_TOKEN")
  await user.click(screen.getByTestId("site-secret-add"))
  await user.type(screen.getByLabelText('environment.secretAction.set:{"key":"NEW_TOKEN"}'), "v")
  await user.click(screen.getByTestId("site-environment-save"))

  expect(onSave).toHaveBeenCalledWith({
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: [
      { key: "API_TOKEN", action: "keep" },
      { key: "NEW_TOKEN", action: "set", value: "v" },
    ],
  })
})

it("loads a historical revision into the editor", async () => {
  const user = userEvent.setup()
  renderTab({
    environments: [
      revision({ id: "e2", sequence: 2, variables: { NEW: "2" } }),
      revision({ id: "e1", sequence: 1, variables: { OLD: "1" } }),
    ],
  })
  await user.click(screen.getByTestId("site-environment-revision-e1"))
  expect(screen.getByTestId("kv-input-environment.variables")).toHaveValue("OLD=1")
})

it("disables editing with a reason when the host cannot save", () => {
  renderTab({ gate: blocked })
  const button = screen.getByTestId("site-environment-edit")
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute("title", "Desktop only")
})
