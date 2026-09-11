import React from "react"
import { renderToString } from "ink"
import { McpPanel } from "../components/McpPanel"
import { CliI18nProvider } from "../i18n"

const noop = () => {}
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
        <McpPanel
          width={columns}
          maxRows={rows - 9}
          runtimeBackend="codex"
          probing={false}
          servers={Array.from({ length: 30 }, (_, index) => ({
            name: `server-${index}`,
            transport: "http",
            enabled: true,
            source: "cognia" as const,
            status: "connected" as const,
            sessionStatus: "submitted" as const,
            sessionError: "Configuration submitted; waiting for agent confirmation.",
            probedAt: 1000,
          }))}
          onRefresh={noop}
          onApply={noop}
          onTools={noop}
          onAuth={noop}
          onReconnect={noop}
          onToggle={noop}
          onAdd={noop}
          onRemove={noop}
          onCancel={noop}
        />
      </CliI18nProvider>,
      { columns }
    ),
  }))
)
process.stdout.write(JSON.stringify(frames))
