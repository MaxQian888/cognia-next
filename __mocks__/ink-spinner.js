/**
 * CJS-compatible mock for `ink-spinner` (ESM-only) used in Jest tests.
 *
 * The real component animates a spinner glyph on a timer; tests never assert on
 * the glyph (see the TUI testing strategy — assert the pure-built label, not the
 * animation). The mock renders a static marker so the surrounding layout still
 * mounts under jsdom.
 */
const React = require("react")

function Spinner({ type } = {}) {
  return React.createElement("span", { "data-ink": "spinner", "data-spinner": type || "dots" }, "⠋")
}

module.exports = Spinner
module.exports.default = Spinner
module.exports.__esModule = true
