---
"cognia-next": minor
---

The composer now accepts videos and handles animated GIFs as motion instead of a single frame. A staged video or GIF is sampled on the spot into a storyboard, one image of nine timestamped frames, and the preview panel lets you trim it, pick frames evenly or at scene changes, choose how many, send separate frames instead, or send the original file where the model and route can take it (a video-capable Gemini model on the AI SDK runtime, under 10 MB). An option the conversation cannot use stays visible with the reason. If the model that actually runs turns out not to take video, the storyboard goes instead and a toast says so. Files the webview cannot decode fall back to ffmpeg in the desktop app. Sources up to 500 MB are accepted. The sent message shows a video card with what the model received, and says that the original file is not stored. Previously every video was refused, and a GIF wider than 1568 px was silently flattened to its first frame.
