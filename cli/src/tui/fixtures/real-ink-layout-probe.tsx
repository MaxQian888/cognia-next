import React from "react"
import { Box, Text, renderToString } from "ink"

import { composerViewport } from "../input/composer-viewport"
import { bufferFromText } from "../input/buffer"
import { contentRows, terminalLayout } from "../layout/terminal-layout"
import { TuiViewportFrame } from "../components/app/TuiViewportFrame"

const sizes = [
  [20, 8],
  [40, 12],
  [80, 24],
  [160, 50],
] as const

function Frame({ columns, rows }: { columns: number; rows: number }): React.ReactElement {
  const layout = terminalLayout(columns, rows)
  const bottomRows = layout.tier === "tiny" ? 2 : 3
  const overlayRows = Math.max(0, rows - bottomRows - (layout.showBanner ? 1 : 0))
  const items = Math.max(1, contentRows(overlayRows, 2))
  const composer = composerViewport(
    bufferFromText("first\nsecond\ncaret 中👩‍💻"),
    Math.max(1, columns - 6),
    layout.composerRows
  )

  return (
    <TuiViewportFrame
      columns={columns}
      rows={rows}
      fullscreen
      overlayOpen
      transcript={layout.showBanner ? <Text>HEADER</Text> : null}
      overlays={
        <Box flexDirection="column">
          {Array.from({ length: items }, (_, index) => (
            <Text key={index}>{index === items - 1 ? "SELECTED" : `row ${index}`}</Text>
          ))}
        </Box>
      }
      bottom={
        <Box flexDirection="column" flexShrink={0}>
          {composer.rows.map((row, index) => (
            <Text key={`${row.logicalRow}:${row.start}:${index}`}>
              {index === composer.rows.length - 1 ? "COMPOSER " : ""}
              {row.text}
            </Text>
          ))}
          {layout.tier === "tiny" ? null : <Text>FOOTER</Text>}
        </Box>
      }
    />
  )
}

const frames = sizes.map(([columns, rows]) => ({
  columns,
  rows,
  frame: renderToString(<Frame columns={columns} rows={rows} />, { columns }),
}))

process.stdout.write(JSON.stringify(frames))
