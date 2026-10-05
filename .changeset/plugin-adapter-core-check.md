---
"cognia-next": patch
---

A plugin-provided external agent that lacks a required method now fails to load with a message naming the method, instead of crashing later in the middle of a turn, and Python-backed adapters gain their missing session list and health check.
