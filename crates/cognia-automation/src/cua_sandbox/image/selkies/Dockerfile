# Cognia Linux Desktop with a Selkies stream (ADR-0234 Phase 4).
#
# A local, opt-in variant layered on the built-in desktop image. The released
# pixelflux wheel bundles GPL x264, x265 and FFmpeg, so this image is only ever
# built on the user's machine and never published by Cognia. The base desktop,
# its computer-server and its token handling are unchanged; this layer adds
# Selkies beside them and a startup that supervises both.
ARG BASE_IMAGE=cognia-cua-desktop:0.3.46-2
FROM ${BASE_IMAGE}

# uv installs the Selkies environment. Pinned by index digest, like the base.
COPY --from=ghcr.io/astral-sh/uv:0.11.33@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 /uv /usr/local/bin/uv
# Optional package index (a PyPI mirror). Unset unless passed as a build arg.
ARG UV_DEFAULT_INDEX

# Runtime libraries the upstream Selkies package declares (infra/packaging/deb.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libpulse0 libxcb1 libxkbcommon0 libx11-xcb1 libva2 libva-drm2 libva-x11-2 \
      libdrm2 libgbm1 libegl1 libwayland-server0 libglib2.0-0 libpixman-1-0 \
      libxcb-render0 libxcb-shm0 libxcb-dri3-0 libxfixes3 libxext6 libice6 libsm6 \
    && rm -rf /var/lib/apt/lists/* \
    && uv venv --no-python-downloads --python /usr/local/bin/python3 /opt/selkies \
    && uv pip install --no-cache --python /opt/selkies/bin/python \
      --only-binary pixelflux --only-binary pcmflux \
      'selkies==2.0.0' 'pixelflux==2.1.0' 'pcmflux==2.1.0' \
    && /opt/selkies/bin/python -c "import importlib.metadata as m; assert m.version('selkies') == '2.0.0' and m.version('pixelflux') == '2.1.0'" \
    && test -x /opt/selkies/bin/selkies

# Drops Selkies' per-frame warning for viewer acks (see sitecustomize.py).
COPY sitecustomize.py /opt/selkies/lib/python3.12/site-packages/sitecustomize.py
RUN /opt/selkies/bin/python -c "import logging, sitecustomize; assert logging.getLogger('ws').filters"
COPY prepare-web-root.py stream-health.js /opt/cognia-desktop/
RUN /opt/selkies/bin/python /opt/cognia-desktop/prepare-web-root.py
COPY selkies-startup.py /opt/cognia-desktop/selkies-startup.py
COPY selkies-entrypoint.sh /usr/local/bin/cognia-desktop-selkies
RUN chmod 0755 /usr/local/bin/cognia-desktop-selkies

LABEL cognia.cua.selkies="2.0.0" cognia.cua.selkies.health="1"
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cognia-desktop-selkies"]
