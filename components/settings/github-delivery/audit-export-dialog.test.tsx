/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import JSZip from "jszip"
import { AuditExportDialog, buildExportBlob, type AuditExportColumn } from "./audit-export-dialog"

// jsdom's Blob doesn't implement `text` / `arrayBuffer` consistently across
// versions; the helpers below read a Blob through FileReader, which jsdom
// does ship.
async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error)
    fr.readAsText(blob)
  })
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer))
    fr.onerror = () => reject(fr.error)
    fr.readAsArrayBuffer(blob)
  })
}

interface Row {
  id: number
  ts: number
  reason: string
}

const COLUMNS: AuditExportColumn<Row>[] = [
  { header: "Time", accessor: (r) => new Date(r.ts).toISOString() },
  { header: "Reason", accessor: (r) => r.reason },
]

const ROWS: Row[] = [
  { id: 1, ts: Date.UTC(2026, 4, 13, 1, 2, 3), reason: "ok" },
  { id: 2, ts: Date.UTC(2026, 4, 13, 1, 2, 4), reason: 'has "quote",and comma' },
]

describe("buildExportBlob", () => {
  it("produces CSV with RFC4180 quoting", async () => {
    const blob = await buildExportBlob("csv", ROWS, COLUMNS)
    const text = await blobText(blob)
    const lines = text.split("\n")
    expect(lines[0]).toBe("Time,Reason")
    expect(lines[1]).toBe("2026-05-13T01:02:03.000Z,ok")
    expect(lines[2]).toBe('2026-05-13T01:02:04.000Z,"has ""quote"",and comma"')
  })

  it("produces Markdown with escaped pipes", async () => {
    const blob = await buildExportBlob("md", [{ id: 1, ts: 0, reason: "a|b" }], COLUMNS)
    const text = await blobText(blob)
    expect(text).toContain("| Time | Reason |")
    expect(text).toContain("a\\|b")
  })

  it("produces JSON identical to the input rows", async () => {
    const blob = await buildExportBlob("json", ROWS, COLUMNS)
    const parsed = JSON.parse(await blobText(blob))
    expect(parsed).toEqual(ROWS)
  })

  it("ZIP bundles audit.csv + audit.json + meta.json with the filter snapshot", async () => {
    const blob = await buildExportBlob("zip", ROWS, COLUMNS, { workflow: "wf_x" })
    const bytes = await blobBytes(blob)
    const zip = await JSZip.loadAsync(bytes)
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(["audit.csv", "audit.json", "meta.json"])
    const meta = JSON.parse(await zip.file("meta.json")!.async("string"))
    expect(meta.rowCount).toBe(2)
    expect(meta.columns).toEqual(["Time", "Reason"])
    expect(meta.filters).toEqual({ workflow: "wf_x" })
  })
})

describe("AuditExportDialog", () => {
  it("calls onExport with the chosen format", async () => {
    const onExport = jest.fn()
    render(<AuditExportDialog rows={ROWS} columns={COLUMNS} filename="test" onExport={onExport} />)
    fireEvent.click(screen.getByTestId("audit-export-trigger"))
    fireEvent.click(await screen.findByTestId("audit-export-confirm"))
    await new Promise((r) => setTimeout(r, 0))
    expect(onExport).toHaveBeenCalledTimes(1)
    const [format, blob] = onExport.mock.calls[0]
    expect(format).toBe("zip")
    expect(blob).toBeInstanceOf(Blob)
  })

  it("disables the confirm button when there are no rows", async () => {
    render(<AuditExportDialog rows={[]} columns={COLUMNS} filename="empty" onExport={jest.fn()} />)
    fireEvent.click(screen.getByTestId("audit-export-trigger"))
    const confirm = (await screen.findByTestId("audit-export-confirm")) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })
})
