/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { makeSpan } from "@/lib/observability/fixtures"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
}))

const success = jest.fn()
const error = jest.fn()
const info = jest.fn()
// Reference the spies lazily — a bare `{ success, error }` in the factory hits
// the TDZ before the consts above are initialized.
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
    info: (...a: unknown[]) => info(...a),
  },
}))

const copy = jest.fn(async (_value: string) => true)
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, isCopying: false, copy }),
}))

const saveExport = jest.fn(async (_opts: { filename: string; data: string; mimeType: string }) => ({
  kind: "saved" as const,
}))
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: { filename: string; data: string; mimeType: string }) => saveExport(opts),
}))

import { TraceExportMenu } from "./trace-export-menu"

const AT = Date.UTC(2026, 7, 19, 15, 4, 5)

function spans(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan[] {
  return [
    makeSpan({ traceId: "trace-abc", spanId: "root", startTime: 1_000, ...over }),
    makeSpan({ traceId: "trace-abc", spanId: "child", startTime: 1_100 }),
  ]
}

async function open(props: Partial<React.ComponentProps<typeof TraceExportMenu>> = {}) {
  const user = userEvent.setup()
  render(<TraceExportMenu traceId="trace-abc" spans={spans()} now={() => AT} {...props} />)
  await user.click(screen.getByTestId("trace-export-trigger"))
  return user
}

beforeEach(() => jest.clearAllMocks())

describe("TraceExportMenu", () => {
  it("is disabled for a trace with no spans", () => {
    render(<TraceExportMenu traceId="t" spans={[]} now={() => AT} />)
    expect(screen.getByTestId("trace-export-trigger")).toBeDisabled()
  })

  it("copies the spans as JSON", async () => {
    const user = await open()
    await user.click(screen.getByTestId("trace-export-copy-json"))
    const payload = JSON.parse(copy.mock.calls[0][0])
    expect(payload).toHaveLength(2)
    expect(payload[0].spanId).toBe("root")
    expect(success).toHaveBeenCalled()
  })

  it("copies the spans as OTLP through the transport's own converter", async () => {
    const user = await open()
    await user.click(screen.getByTestId("trace-export-copy-otlp"))
    const payload = JSON.parse(copy.mock.calls[0][0])
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2)
  })

  it("reports a clipboard failure instead of claiming success", async () => {
    copy.mockResolvedValueOnce(false)
    const user = await open()
    await user.click(screen.getByTestId("trace-export-copy-json"))
    expect(error).toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it("saves through the shared cross-platform writer with a stamped filename", async () => {
    const user = await open()
    await user.click(screen.getByTestId("trace-export-save-otlp"))
    expect(saveExport).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "cognia-trace-trace-abc-2026-08-19-15-04-05.otlp.json",
        mimeType: "application/json",
      })
    )
    expect(success).toHaveBeenCalled()
  })

  it("surfaces a save failure", async () => {
    saveExport.mockResolvedValueOnce({ kind: "error", message: "disk full" } as never)
    const user = await open()
    await user.click(screen.getByTestId("trace-export-save-json"))
    expect(error).toHaveBeenCalled()
  })

  it("stays quiet when the user cancels the picker", async () => {
    saveExport.mockResolvedValueOnce({ kind: "cancelled" } as never)
    const user = await open()
    await user.click(screen.getByTestId("trace-export-save-json"))
    expect(error).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it("offers the redaction toggle only when the trace carries previews", async () => {
    await open()
    expect(screen.queryByTestId("trace-export-redact")).not.toBeInTheDocument()
  })

  it("strips previews once the toggle is on", async () => {
    const user = userEvent.setup()
    render(
      <TraceExportMenu
        traceId="trace-abc"
        spans={spans({ inputPreview: "secret prompt" })}
        now={() => AT}
      />
    )
    await user.click(screen.getByTestId("trace-export-trigger"))
    await user.click(screen.getByTestId("trace-export-redact"))
    await user.click(screen.getByTestId("trace-export-copy-json"))
    expect(copy.mock.calls.at(-1)?.[0]).not.toContain("secret prompt")
  })

  it("keeps previews by default", async () => {
    const user = userEvent.setup()
    render(
      <TraceExportMenu
        traceId="trace-abc"
        spans={spans({ inputPreview: "secret prompt" })}
        now={() => AT}
      />
    )
    await user.click(screen.getByTestId("trace-export-trigger"))
    await user.click(screen.getByTestId("trace-export-copy-json"))
    expect(copy.mock.calls.at(-1)?.[0]).toContain("secret prompt")
  })
})
