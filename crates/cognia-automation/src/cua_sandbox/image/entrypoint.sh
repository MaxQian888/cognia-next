#!/bin/sh
set -eu

# The root entrypoint only prepares writable runtime directories. All desktop
# programs and the computer server run as the existing exec-channel user.
install -d -m 1777 /tmp/.X11-unix
install -d -m 0700 -o cua -g cua /run/user/1000
chown cua:cua /home/cua
export HOME=/home/cua DISPLAY=:99 XDG_RUNTIME_DIR=/run/user/1000
exec gosu cua /usr/local/bin/python3 -I /opt/cognia-desktop/startup.py
