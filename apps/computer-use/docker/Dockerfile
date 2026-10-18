# Allowance computer-use desktop (docs/ARCHITECTURE.md §19).
#
# A small Linux desktop for one agent session: Xvfb (1280x800), Openbox, Chromium, xdotool for
# input, ffmpeg for screenshots and the live MJPEG stream, and a tiny control server (server.py).
# One container per session; the service removes it when the session ends.
#
# Isolation is set by the service's `docker run` (no mounts, not privileged, read-only root, cpu and
# memory limits) plus firewall.sh, which runs first as root and blocks every private, loopback and
# link-local destination except the container's own loopback. Everything after it runs as the
# unprivileged user `cu` (uid 64000, which no host account uses), with no capabilities, so it
# cannot change the rules.
FROM alpine:3.24

RUN apk add --no-cache \
      xvfb openbox xdotool chromium ffmpeg \
      python3 py3-websocket-client \
      iptables ip6tables su-exec \
      font-dejavu font-liberation font-wqy-zenhei font-noto-emoji \
 && adduser -D -u 64000 -h /tmp/home cu \
 && mkdir -p /etc/chromium/policies/managed

COPY policy.json /etc/chromium/policies/managed/allowance.json
COPY openbox.xml entrypoint.sh firewall.sh desktop.sh server.py snapshot.js /opt/cu/
RUN chmod 0755 /opt/cu/entrypoint.sh /opt/cu/firewall.sh /opt/cu/desktop.sh \
 && chmod 0644 /opt/cu/server.py /opt/cu/snapshot.js /opt/cu/openbox.xml

ENV CU_WIDTH=1280 CU_HEIGHT=800 DISPLAY=:99
EXPOSE 8080
ENTRYPOINT ["/opt/cu/entrypoint.sh"]
