"""Quiet one Selkies 2.0.0 warning in the Cognia Selkies variant (ADR-0234).

Every viewer's page acknowledges each video frame (`CLIENT_FRAME_ACK`).
Selkies only uses the acks of the client that owns the display, so it drops a
viewer's ack, which is correct, but logs a warning for each one: about 20
lines a second per open viewer into the container log. This filter drops
exactly that warning. Every other refused viewer message is still logged.

Installed as the Selkies virtualenv's `sitecustomize`, so it is in place
before Selkies imports its logger. `logging.basicConfig(force=True)` resets
the root handlers only, not this logger's filters.
"""

import logging

DENIED_VIEWER = "DENIED unauthorized message from viewer "
FRAME_ACK = ": CLIENT_FRAME_ACK"


class DropViewerFrameAcks(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        return not (message.startswith(DENIED_VIEWER) and FRAME_ACK in message)


logging.getLogger("ws").addFilter(DropViewerFrameAcks())
