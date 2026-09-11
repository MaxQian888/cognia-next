import React from "react"
import { renderToString } from "ink"
import { DocumentViewer } from "../components/overlays/DocumentViewer"
import { CliI18nProvider } from "../i18n"
import { buildContextReport, formatSdkContextBreakdown } from "../commands/context-report"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
const frames = (["en", "zh-CN"] as const).flatMap((locale) =>
  [
    [80, 24],
    [120, 40],
  ].map(([columns, rows]) => ({
    columns,
    rows,
    locale,
    frame: renderToString(
      <CliI18nProvider locale={locale}>
        <DocumentViewer
          title="Context details"
          columns={columns}
          viewportRows={rows - 3}
          format="markdown"
          onClose={() => {}}
          body={
            formatSdkContextBreakdown(
              {
                totalTokens: 123456,
                maxTokens: 200000,
                percentage: 61.728,
                categories: Array.from({ length: 30 }, (_, i) => ({
                  name: `Category ${i}`,
                  tokens: i * 100,
                })),
                mcpTools: Array.from({ length: 40 }, (_, i) => ({
                  name: `tool-${i}`,
                  serverName: "server",
                  tokens: 125,
                })),
              },
              locale
            ) +
            "\n\n" +
            buildContextReport(
              { contextTokens: 123456, contextWindow: 200000, outputTokens: 345 },
              { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", locale }
            )
          }
        />
      </CliI18nProvider>,
      { columns }
    ),
  }))
)
process.stdout.write(JSON.stringify(frames))
