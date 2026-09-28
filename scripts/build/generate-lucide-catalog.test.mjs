import assert from "node:assert/strict"
import test from "node:test"
import * as lucideExports from "lucide-react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { buildLucideCatalog, serializeLucideCatalog } from "./generate-lucide-catalog.mjs"

test("buildLucideCatalog sorts exports and preserves SVG node data", () => {
  const icon = (className, iconNode) => ({
    render: () => ({ props: { className, iconNode } }),
  })
  const alpha = icon("lucide-alpha", [["circle", { cx: 1, cy: 1, r: 1 }]])
  const catalog = buildLucideCatalog(
    {
      Zebra: icon("lucide-zebra", [["path", { d: "z" }]]),
      Alpha: alpha,
    },
    { Alpha: alpha, AlphaIcon: alpha }
  )

  assert.deepEqual(Object.keys(catalog.entries), ["Alpha", "Zebra"])
  assert.deepEqual(catalog.iconNames, ["Alpha", "Zebra"])
  assert.deepEqual(catalog.exportNames, { Alpha: "Alpha", AlphaIcon: "Alpha" })
  assert.equal(serializeLucideCatalog(catalog).endsWith("\n"), true)
  assert.deepEqual(catalog.entries.Alpha.iconNode, [["circle", { cx: 1, cy: 1, r: 1 }]])
})

test("buildLucideCatalog rejects exports without iconNode", () => {
  assert.throws(
    () => buildLucideCatalog({ Broken: { render: () => ({ props: {} }) } }),
    /did not expose iconNode data/
  )
})


test("buildLucideCatalog preserves installed Lucide icon geometry and alias classes", () => {
  const catalog = buildLucideCatalog(lucideExports.icons, lucideExports)
  for (const [name, component] of Object.entries(lucideExports.icons)) {
    const props = component.render({}, null).props
    assert.deepEqual(catalog.entries[name].iconNode, props.icon.node, name)
    const html = renderToStaticMarkup(createElement(component))
    const classes = html.match(/class="([^"]+)"/)[1].split(" ").filter((v) => v !== "lucide")
    assert.deepEqual(catalog.entries[name].className.split(" "), classes, name)
  }
  assert.equal(catalog.exportNames.AlarmCheck, catalog.exportNames.AlarmClockCheck)
})
