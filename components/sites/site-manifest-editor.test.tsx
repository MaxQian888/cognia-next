import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

// CodeMirror needs DOM-measurement shims jsdom lacks; swap it for a textarea
// honouring the same value/onChange/readOnly contract so these tests exercise
// the editor's own logic.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({
    value,
    onChange,
    readOnly,
    "data-testid": testId,
  }: {
    value: string
    onChange: (next: string) => void
    readOnly?: boolean
    "data-testid"?: string
  }) => (
    <textarea
      data-testid={testId}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import type { SiteHostingManifestController } from "@/hooks/sites/use-site-hosting-manifest"
import { SiteManifestEditor } from "./site-manifest-editor"

const VALID = `${JSON.stringify(
  {
    schemaVersion: 1,
    build: { command: ["pnpm", "build"], entry: ".cognia/worker.js", assets: "dist" },
    preview: { command: ["pnpm", "dev"], url: "http://localhost:5173" },
    cloudflare: { compatibilityDate: "2026-08-19", compatibilityFlags: [], bindings: [] },
  },
  null,
  2
)}\n`

function controller(
  overrides: Partial<SiteHostingManifestController> = {}
): SiteHostingManifestController {
  return {
    state: {
      status: "ok",
      path: "/repo/.cognia/hosting.json",
      text: VALID,
      manifest: JSON.parse(VALID),
    },
    ready: true,
    text: VALID,
    refresh: jest.fn(async () => undefined),
    scaffold: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined),
    ...overrides,
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = {
  allowed: false,
  reason: "requires-desktop" as const,
  title: "Available on desktop",
}

it("explains itself instead of rendering an editor with no filesystem", () => {
  render(
    <SiteManifestEditor
      manifest={controller({ state: { status: "unsupported" }, ready: false, text: "" })}
      gate={blocked}
      busy={false}
      onSave={jest.fn()}
    />
  )
  expect(screen.getByTestId("site-manifest-unsupported")).toBeInTheDocument()
  expect(screen.queryByTestId("site-manifest-source")).not.toBeInTheDocument()
})

it("offers a scaffold when there is no manifest yet", async () => {
  const user = userEvent.setup()
  const scaffold = jest.fn(async () => ({
    kind: "vite" as const,
    packageManager: "pnpm" as const,
    confidence: "detected" as const,
    manifest: JSON.parse(VALID),
    extraFiles: [{ relativePath: ".cognia/worker.js", contents: "export default {}" }],
    text: VALID,
  }))
  render(
    <SiteManifestEditor
      manifest={controller({
        state: { status: "missing", path: "/repo/.cognia/hosting.json" },
        ready: false,
        text: "",
        scaffold,
      })}
      gate={allowed}
      busy={false}
      onSave={jest.fn()}
    />
  )

  expect(screen.getByTestId("site-manifest-missing")).toBeInTheDocument()
  await user.click(screen.getByTestId("site-manifest-scaffold"))

  await waitFor(() => expect(screen.getByTestId("site-manifest-source")).toHaveValue(VALID))
  expect(screen.getByText(/manifest.detected/)).toBeInTheDocument()
  expect(screen.getByText('manifest.extraFiles:{"count":1}')).toBeInTheDocument()
})

it("labels an unrecognized project as a template that needs review", async () => {
  const user = userEvent.setup()
  render(
    <SiteManifestEditor
      manifest={controller({
        state: { status: "missing", path: "/p" },
        ready: false,
        text: "",
        scaffold: jest.fn(async () => ({
          kind: "unknown" as const,
          packageManager: "npm" as const,
          confidence: "template" as const,
          manifest: JSON.parse(VALID),
          extraFiles: [],
          text: VALID,
        })),
      })}
      gate={allowed}
      busy={false}
      onSave={jest.fn()}
    />
  )
  await user.click(screen.getByTestId("site-manifest-scaffold"))
  await waitFor(() => expect(screen.getByText("manifest.confidence.template")).toBeInTheDocument())
})

it("blocks saving a draft the real parser rejects", async () => {
  const user = userEvent.setup()
  const onSave = jest.fn()
  render(<SiteManifestEditor manifest={controller()} gate={allowed} busy={false} onSave={onSave} />)

  const save = screen.getByTestId("site-manifest-save")
  expect(save).toBeEnabled()

  await user.clear(screen.getByTestId("site-manifest-source"))
  // `type` reads `{` as user-event keyboard syntax; paste the JSON verbatim.
  await user.click(screen.getByTestId("site-manifest-source"))
  await user.paste('{"schemaVersion": 2}')

  expect(await screen.findByRole("alert")).toHaveTextContent(/manifest.invalid/)
  expect(save).toBeDisabled()
  expect(onSave).not.toHaveBeenCalled()
})

it("saves the draft together with any scaffolded companion files", async () => {
  const user = userEvent.setup()
  const onSave = jest.fn()
  render(
    <SiteManifestEditor
      manifest={controller({
        state: { status: "missing", path: "/p" },
        ready: false,
        text: "",
        scaffold: jest.fn(async () => ({
          kind: "vite" as const,
          packageManager: "pnpm" as const,
          confidence: "detected" as const,
          manifest: JSON.parse(VALID),
          extraFiles: [{ relativePath: ".cognia/worker.js", contents: "export default {}" }],
          text: VALID,
        })),
      })}
      gate={allowed}
      busy={false}
      onSave={onSave}
    />
  )
  await user.click(screen.getByTestId("site-manifest-scaffold"))
  await waitFor(() => expect(screen.getByTestId("site-manifest-save")).toBeEnabled())
  await user.click(screen.getByTestId("site-manifest-save"))

  expect(onSave).toHaveBeenCalledWith(VALID, [
    { relativePath: ".cognia/worker.js", contents: "export default {}" },
  ])
})

it("shows the parser message for a manifest already broken on disk", () => {
  render(
    <SiteManifestEditor
      manifest={controller({
        state: {
          status: "invalid",
          path: "/p",
          text: '{"schemaVersion": 2}',
          error: "unsupported schema version",
        },
        ready: false,
        text: '{"schemaVersion": 2}',
      })}
      gate={allowed}
      busy={false}
      onSave={jest.fn()}
    />
  )
  // The alert reflects live validation of the draft, which is seeded from the
  // broken file — same message the build would have produced.
  expect(screen.getByRole("alert")).toHaveTextContent(/unsupported .*schema version/)
})

it("renders read-only with the gate reason when the host cannot write", () => {
  render(
    <SiteManifestEditor manifest={controller()} gate={blocked} busy={false} onSave={jest.fn()} />
  )
  expect(screen.getByTestId("site-manifest-source")).toHaveAttribute("readonly")
  expect(screen.getByTestId("site-manifest-save")).toBeDisabled()
  expect(screen.getByTestId("site-manifest-save")).toHaveAttribute("title", "Available on desktop")
  expect(screen.getByTestId("site-manifest-scaffold")).toBeDisabled()
})

it("re-indents a valid draft in place", async () => {
  const user = userEvent.setup()
  const compact = JSON.stringify(JSON.parse(VALID))
  render(
    <SiteManifestEditor
      manifest={controller({
        state: { status: "ok", path: "/p", text: compact, manifest: JSON.parse(VALID) },
        text: compact,
      })}
      gate={allowed}
      busy={false}
      onSave={jest.fn()}
    />
  )
  await user.click(screen.getByText("actions.formatManifest"))
  expect(screen.getByTestId("site-manifest-source")).toHaveValue(VALID)
})

it("re-reads from disk on demand", async () => {
  const user = userEvent.setup()
  const refresh = jest.fn(async () => undefined)
  render(
    <SiteManifestEditor
      manifest={controller({ refresh })}
      gate={allowed}
      busy={false}
      onSave={jest.fn()}
    />
  )
  await user.click(screen.getByText("actions.reloadManifest"))
  expect(refresh).toHaveBeenCalledTimes(1)
})
