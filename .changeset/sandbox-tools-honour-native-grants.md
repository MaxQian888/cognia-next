---
"cognia-next": patch
---

Sandboxed tools now honour the `native:filesystem` / `native:process` permissions the consent UI describes. `sandbox_exec` previously validated only the path/network policy and never read a grant, so revoking either permission — or disabling the Sandboxed Tools plugin — changed nothing. Sandbox audit entries are also attributed to the owning plugin instead of being recorded with no plugin id.
