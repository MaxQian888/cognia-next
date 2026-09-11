import React from "react"
import { renderToString } from "ink"
import { HooksOverlay } from "../components/overlays/HooksOverlay"
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
        <HooksOverlay
          width={columns}
          maxRows={rows - 9}
          rows={Array.from({ length: 40 }, (_, i) => ({
            id: `hook-${i}`,
            label: `hook-${i}`,
            source: "builtin" as const,
            event: "PreToolUse",
            enabled: true,
            detail: "command",
          }))}
          diagnostics={["Configuration inventory"]}
          onToggle={noop}
          onEdit={noop}
          onRefresh={noop}
          onClose={noop}
        />
      </CliI18nProvider>,
      { columns }
    ),
  }))
)
process.stdout.write(JSON.stringify(frames))
