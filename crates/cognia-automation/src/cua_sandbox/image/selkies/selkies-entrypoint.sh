#!/bin/sh
set -eu

# The Selkies variant has one startup mode. Managed desktops never get a TCP
# listener (ADR-0233), so `--managed` is refused here rather than forwarded.
if [ "$#" -ne 0 ]; then
    echo "The Selkies desktop variant has no alternate startup mode" >&2
    exit 1
fi

install -d -m 1777 /tmp/.X11-unix
install -d -m 0700 -o cua -g cua /run/user/1000
chown cua:cua /home/cua
export HOME=/home/cua DISPLAY=:99 XDG_RUNTIME_DIR=/run/user/1000
exec gosu cua /usr/local/bin/python3 -I /opt/cognia-desktop/selkies-startup.py
