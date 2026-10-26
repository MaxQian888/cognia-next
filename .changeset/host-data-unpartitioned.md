---
"cognia-next": patch
---

Multi-tenant Hosts refuse Host-stored client data commands (messages, files library, pet, issues, characters, glance, push tokens) from tenant devices with `host_data_unpartitioned` until that data is partitioned per person; single-user Hosts are unchanged.
