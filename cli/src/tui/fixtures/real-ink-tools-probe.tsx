import React from "react"
import { renderToString } from "ink"
import { ToolBrowser } from "../components/ToolBrowser"
import { CliI18nProvider } from "../i18n"
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
        <ToolBrowser
          title="Tools"
          width={columns}
          maxRows={rows - 9}
          onClose={() => {}}
          entries={Array.from({ length: 100 }, (_, i) => ({
            id: `tool-${i}`,
            name: `tool-${i}`,
            source: "MCP",
            description: "很长的工具说明，需要限制行高以保持分页正确。".repeat(20),
            detail: "full description",
          }))}
        />
      </CliI18nProvider>,
      { columns }
    ),
  }))
)
process.stdout.write(JSON.stringify(frames))
