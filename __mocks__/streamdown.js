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

module.exports = { Block, Streamdown, parseMarkdownIntoBlocks }
