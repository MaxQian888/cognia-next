import type { GatewayRequestLogRow } from "@/types/gateway"

import {
  downloadGatewayRequestLog,
  gatewayRequestLogFileName,
  gatewayRequestLogToCsv,
  gatewayRequestLogToJson,
} from "./request-log-export"

const mockDownloadFile = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
}))

const row = (over: Partial<GatewayRequestLogRow> = {}): GatewayRequestLogRow => ({
  id: "r1",
  at: "2026-09-25T06:30:05.000Z",
  route: "/v1/chat/completions",
  remoteIp: "127.0.0.1",
  keyId: "k1",
  model: "fast",
  providerId: "groq",
  status: 200,
  latencyMs: 12,
  inputTokens: 3,
  outputTokens: 5,
  error: null,
  stream: true,
  ...over,
})

beforeEach(() => mockDownloadFile.mockReset())

describe("gatewayRequestLogToCsv", () => {
  it("writes a header and one line per row, blanking absent values", () => {
    const csv = gatewayRequestLogToCsv([row({ inputTokens: null })])
    const [header, line] = csv.split("\n")

    expect(header.split(",")[0]).toBe("at")
    expect(line).toBe(
      "2026-09-25T06:30:05.000Z,200,12,/v1/chat/completions,fast,groq,k1,127.0.0.1,,5,true,,,,,,"
    )
  })

  it("quotes cells carrying commas, quotes or newlines", () => {
    const csv = gatewayRequestLogToCsv([row({ error: 'bad "value", then\nmore' })])

    expect(csv).toContain('"bad ""value"", then\nmore"')
  })

  it("neutralises cells that a spreadsheet would evaluate as a formula", () => {
    // Model ids come from whichever client called the gateway.
    const csv = gatewayRequestLogToCsv([row({ model: '=HYPERLINK("http://x")', error: "@cmd" })])

    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(csv).toContain("'@cmd")
  })

  it("summarises the attempt chain as a count", () => {
    const csv = gatewayRequestLogToCsv([
      row({
        attempts: [
          { providerId: "a", modelId: "m", latencyMs: 1 },
          { providerId: "b", modelId: "m", latencyMs: 2 },
        ],
      }),
    ])

    expect(csv.split("\n")[1].split(",")[14]).toBe("2")
  })
})

describe("gatewayRequestLogToJson", () => {
  it("keeps every field, including the full attempt chain", () => {
    const attempts = [{ providerId: "a", modelId: "m", latencyMs: 1, reason: "429" }]
    expect(JSON.parse(gatewayRequestLogToJson([row({ attempts })]))).toEqual([row({ attempts })])
  })
})

describe("downloadGatewayRequestLog", () => {
  const now = new Date(2026, 8, 25, 14, 30, 5)

  it("names the file after the local time and format", () => {
    expect(gatewayRequestLogFileName("csv", now)).toBe("cognia-gateway-log-20260925-143005.csv")
  })

  it("downloads CSV as text/csv", () => {
    downloadGatewayRequestLog([row()], "csv", now)

    expect(mockDownloadFile).toHaveBeenCalledWith(
      "cognia-gateway-log-20260925-143005.csv",
      expect.stringContaining("fast"),
      "text/csv"
    )
  })

  it("downloads JSON as application/json", () => {
    downloadGatewayRequestLog([row()], "json", now)

    expect(mockDownloadFile).toHaveBeenCalledWith(
      "cognia-gateway-log-20260925-143005.json",
      expect.stringContaining('"model": "fast"'),
      "application/json"
    )
  })
})
