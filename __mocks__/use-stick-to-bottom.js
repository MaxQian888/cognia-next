const React = require("react")

const StickToBottom = React.forwardRef(({ children, ...props }, ref) =>
  React.createElement("div", { ...props, ref }, children)
)
StickToBottom.displayName = "StickToBottom"
StickToBottom.Content = React.forwardRef(({ children, ...props }, ref) =>
  React.createElement("div", { ...props, ref }, children)
)
StickToBottom.Content.displayName = "StickToBottomContent"

module.exports = {
  StickToBottom,
  useStickToBottomContext: () => ({ isAtBottom: true, scrollToBottom: jest.fn() }),
}
