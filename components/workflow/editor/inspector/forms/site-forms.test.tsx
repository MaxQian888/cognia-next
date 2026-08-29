import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
// CodeMirror needs layout jsdom does not provide; every form suite here stubs
// it the same way.
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({
    id,
    value,
    onChange,
  }: {
    id?: string
    value: string
    onChange: (value: string) => void
  }) => <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} />,
}))

/** `Field` renders its `<Label>` without a `for`, but tags the wrapper with
 * `data-field` — the handle the other form suites use. */
function field(container: HTMLElement, name: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-field="${name}"]`)
  if (!node) throw new Error(`no field named ${name}`)
  return node
}

/** `ExpressionField` renders a contenteditable/textarea rather than an input. */
function input(container: HTMLElement, name: string): HTMLElement {
  const node = field(container, name).querySelector<HTMLElement>(
    "input, textarea, [contenteditable]"
  )
  if (!node) throw new Error(`field ${name} has no editor`)
  return node
}

import {
  SiteBuildConfig,
  SiteDeployConfig,
  SiteRollbackConfig,
  SiteStatusConfig,
} from "./site-forms"

it.each([
  ["build", SiteBuildConfig],
  ["deploy", SiteDeployConfig],
  ["rollback", SiteRollbackConfig],
  ["status", SiteStatusConfig],
] as const)("%s asks which Site it acts on", (_name, Config) => {
  const { container } = render(<Config params={{}} onChange={jest.fn()} />)
  expect(field(container, "siteId")).toHaveTextContent("siteId.label")
})

it("reports the Site id as the author types it", async () => {
  const user = userEvent.setup()
  const onChange = jest.fn()
  const { container } = render(<SiteStatusConfig params={{}} onChange={onChange} />)
  await user.type(input(container, "siteId"), "s")
  expect(onChange).toHaveBeenLastCalledWith({ siteId: "s" })
})

it("offers the build inputs that shape the sandbox", () => {
  const { container } = render(<SiteBuildConfig params={{}} onChange={jest.fn()} />)
  for (const name of ["runtime", "packageManager", "installNetworkHosts", "buildNetworkHosts"]) {
    expect(field(container, name)).toBeInTheDocument()
  }
})

it("splits a host list into an array, not a string", async () => {
  // The executor's schema expects `string[]`; a comma-joined string would be
  // rejected at validation instead of at the keystroke.
  const user = userEvent.setup()
  const onChange = jest.fn()
  const { container } = render(<SiteBuildConfig params={{}} onChange={onChange} />)
  await user.type(input(container, "buildNetworkHosts"), "a")
  expect(onChange).toHaveBeenLastCalledWith({ buildNetworkHosts: ["a"] })
})

it("renders a stored host array back as a readable list", () => {
  const { container } = render(
    <SiteBuildConfig
      params={{ installNetworkHosts: ["registry.npmjs.org", "cdn.example.com"] }}
      onChange={jest.fn()}
    />
  )
  expect(input(container, "installNetworkHosts")).toHaveValue("registry.npmjs.org, cdn.example.com")
})

it("lets deploy name a version, and treats empty as newest-ready", () => {
  const { container } = render(<SiteDeployConfig params={{ siteId: "s1" }} onChange={jest.fn()} />)
  expect(input(container, "versionId")).toHaveValue("")
})

it("asks rollback for nothing but the Site — it resolves the target itself", () => {
  const { container } = render(<SiteRollbackConfig params={{}} onChange={jest.fn()} />)
  expect(container.querySelector('[data-field="versionId"]')).toBeNull()
})
