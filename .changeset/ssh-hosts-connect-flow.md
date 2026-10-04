---
"cognia-next": minor
---

SSH hosts get a proper home and one connect flow. Settings → Terminal is now a topic rail (Appearance, Shell, Host, Launch profiles, SSH hosts, …) and the SSH hosts editor lists each host as one summary line with Connect, Test connection, Browse files, Duplicate and confirmed Remove. Every "fix this in Settings" link opens the right host. The dock, device console, phone and settings share one connect flow: a missing password on the target or a jump host, or a broken jump chain, is caught before dialing with a button that opens the profile to fix; a re-trusted host key reconnects automatically; Restart on an SSH tab reconnects instead of starting a local shell. Idle SSH sessions no longer drop after 30 seconds, paired devices and SFTP now reach bastion-backed hosts through their jump hosts, a desktop driving a remote host still dials its own SSH hosts, and a device's SSH spawn can never open the desktop's port forwards.
