const React = require("react")

const element = (tag, displayName) => {
  const Component = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement(tag, { ...props, ref }, children)
  )
  Component.displayName = displayName
  return Component
}

module.exports = {
  MediaControlBar: element("div", "MediaControlBar"),
  MediaController: element("div", "MediaController"),
  MediaDurationDisplay: element("span", "MediaDurationDisplay"),
  MediaMuteButton: element("button", "MediaMuteButton"),
  MediaPlayButton: element("button", "MediaPlayButton"),
  MediaSeekBackwardButton: element("button", "MediaSeekBackwardButton"),
  MediaSeekForwardButton: element("button", "MediaSeekForwardButton"),
  MediaTimeDisplay: element("span", "MediaTimeDisplay"),
  MediaTimeRange: element("input", "MediaTimeRange"),
  MediaVolumeRange: element("input", "MediaVolumeRange"),
}
