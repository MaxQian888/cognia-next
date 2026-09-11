import React from "react"
import { renderToString } from "ink"
import { FolderPicker } from "../components/FolderPicker"
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
        <FolderPicker
          initialDir="/workspace"
          width={columns}
          maxRows={rows - 9}
          listDirs={() => Array.from({ length: 40 }, (_, i) => `project-${i}`)}
          onConfirm={noop}
          onCancel={noop}
        />
      </CliI18nProvider>,
      { columns }
    ),
  }))
)
process.stdout.write(JSON.stringify(frames))
