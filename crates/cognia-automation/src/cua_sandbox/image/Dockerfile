FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    HOME=/home/cua \
    XDG_RUNTIME_DIR=/run/user/1000 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CUA_BACKEND=native \
    CUA_TELEMETRY=0 \
    DO_NOT_TRACK=1

# Debian's Chromium and X11 desktop packages support both arm64 and amd64.
# The pinned legacy computer-server speaks the protocol Cognia implements;
# Driver/spacesd is deliberately not substituted for that API.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates chromium dbus-x11 fonts-dejavu fonts-noto-color-emoji \
      gosu openbox xterm xvfb x11-utils x11-xserver-utils xclip \
      gcc libc6-dev linux-libc-dev libx11-6 libxtst6 libxrandr2 libxinerama1 \
    && pip install --no-cache-dir 'cua-computer-server[linux]==0.3.46' \
    && apt-get purge -y --auto-remove gcc libc6-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash cua \
    && mkdir -p /home/cua/.config/openbox /opt/cognia-desktop \
    && chown -R cua:cua /home/cua \
    && test -s /usr/sbin/gosu \
    && test -s /usr/bin/Xvfb \
    && test -s /usr/lib/chromium/chromium \
    && dpkg-query -W gosu xvfb openbox chromium \
    && python3 -c "import importlib.metadata; assert importlib.metadata.version('cua-computer-server') == '0.3.46'"

COPY startup.py /opt/cognia-desktop/startup.py
COPY server.py /opt/cognia-desktop/server.py
COPY entrypoint.sh /usr/local/bin/cognia-desktop
COPY menu.xml /opt/cognia-desktop/menu.xml
RUN chmod 0755 /usr/local/bin/cognia-desktop

LABEL org.opencontainers.image.title="Cognia Linux Desktop" \
      cognia.cua.protocol="computer-server-0.3.46" \
      cognia.cua.recipe="1"
EXPOSE 8000
WORKDIR /home/cua
ENTRYPOINT ["/usr/local/bin/cognia-desktop"]
