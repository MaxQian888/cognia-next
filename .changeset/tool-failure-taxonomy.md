---
"cognia-next": patch
---

A failing tool now tells the model what kind of failure it was and whether repeating the call could help. Before this every failure was one boolean plus free text, so "your disk is full", "you passed the wrong argument", "the user declined" and "the backend is down" arrived looking identical — and the model did the only thing it could with an undifferentiated error, which was to call the tool again. Failures are classified into a closed set (errno wins over message shape, so ENOSPC is never reported as a tool bug), and the ones a repeat cannot fix — invalid arguments, permission denied, user rejected, resource exhausted — carry explicit instructions not to retry and not to route around the refusal. The classification also rides along as typed metadata, so the UI and telemetry can distinguish failure kinds without parsing the prose the model reads.
