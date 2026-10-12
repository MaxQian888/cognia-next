---
"cognia-next": minor
---

`!` commands in the chat composer now run as background jobs. Output streams into a live card in the chat instead of arriving all at once when the command exits. A build or test run is no longer killed after 30 seconds. While a command runs, "Move to background" lets it keep running in Job Center and posts its result to the chat when it exits; "Stop" ends it. Paired browsers and phones get the same behavior through the Host. A Host too old for the job command still runs the line the old way, now with a 120-second limit.
