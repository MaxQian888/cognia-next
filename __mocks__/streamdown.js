const React = require("react")

function Streamdown({ children }) {
  return React.createElement(React.Fragment, null, children)
}

function Block({ content, children }) {
  return React.createElement(React.Fragment, null, content ?? children)
}

function parseMarkdownIntoBlocks(markdown) {
  return [markdown]
}

function tableDataToCSV(data) {
  return [data.headers, ...data.rows].map((row) => row.join(",")).join("\n")
}

function tableDataToTSV(data) {
  return [data.headers, ...data.rows].map((row) => row.join("\t")).join("\n")
}

function tableDataToMarkdown(data) {
  return [
    "| " + data.headers.join(" | ") + " |",
    "| " + data.headers.map(() => "---").join(" | ") + " |",
    ...data.rows.map((row) => "| " + row.join(" | ") + " |"),
  ].join("\n")
}

module.exports = {
  Block,
  Streamdown,
  parseMarkdownIntoBlocks,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
}
