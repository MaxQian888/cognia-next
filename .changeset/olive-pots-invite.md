---
"cognia-next": patch
---

Fix four companion-plane failures that made whole surfaces look empty from a browser or phone: background jobs and monitors now return the object shape their dispatch arms actually send (they were answering 500 `contract_output_violation` against an `array` schema), host-owned external-agent configurations are reachable again (their `signed-policy` gate was structurally unsatisfiable), and client-local commands such as the sandbox probes are refused locally instead of making a doomed round trip for a 403.
