#!/bin/sh
# Runs as root with only NET_ADMIN, SETUID and SETGID (the service drops every other capability).
# 1. Install the egress firewall. If that fails, refuse to start: no session without isolation.
# 2. Switch to the unprivileged user. Changing uid clears every capability, and no-new-privileges
#    stops anything from regaining them, so nothing after this line can touch the rules.
set -eu
if ! /opt/cu/firewall.sh; then
  echo "[cu] firewall setup failed; refusing to start" >&2
  exit 70
fi
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
exec su-exec cu:cu /opt/cu/desktop.sh
