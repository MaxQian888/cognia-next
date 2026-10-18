# Cognia Linux Desktop with a Selkies stream (ADR-0234 Phase 4).
#
# A local, opt-in variant layered on the built-in desktop image. The released
# pixelflux wheel bundles GPL x264, x265 and FFmpeg, so this image is only ever
# built on the user's machine and never published by Cognia. The base desktop,
# its computer-server and its token handling are unchanged; this layer adds
# Selkies beside them and a startup that supervises both.
ARG BASE_IMAGE=cognia-cua-desktop:0.3.46-2
FROM ${BASE_IMAGE}

# Runtime libraries the upstream Selkies package declares (infra/packaging/deb.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libpulse0 libxcb1 libxkbcommon0 libx11-xcb1 libva2 libva-drm2 libva-x11-2 \
      libdrm2 libgbm1 libegl1 libwayland-server0 libglib2.0-0 libpixman-1-0 \
      libxcb-render0 libxcb-shm0 libxcb-dri3-0 libxfixes3 libxext6 libice6 libsm6 \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/selkies \
    && /opt/selkies/bin/pip install --no-cache-dir --only-binary=pixelflux,pcmflux \
      'selkies==2.0.0' 'pixelflux==2.1.0' 'pcmflux==2.1.0' \
    && /opt/selkies/bin/python -c "import importlib.metadata as m; assert m.version('selkies') == '2.0.0' and m.version('pixelflux') == '2.1.0'" \
    && test -x /opt/selkies/bin/selkies

COPY selkies-startup.py /opt/cognia-desktop/selkies-startup.py
COPY selkies-entrypoint.sh /usr/local/bin/cognia-desktop-selkies
RUN chmod 0755 /usr/local/bin/cognia-desktop-selkies

LABEL cognia.cua.selkies="2.0.0"
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cognia-desktop-selkies"]
