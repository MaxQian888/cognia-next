---
"cognia-next": minor
---

A headless Host can bind a loopback tunnel ingress listener for a VS Code dev-tunnel forward (`cognia-server tunnel-ingress enable`). Requests on it never get loopback privileges, whatever their peer address or headers.
