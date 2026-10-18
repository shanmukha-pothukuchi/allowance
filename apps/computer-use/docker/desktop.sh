#!/bin/sh
# Runs as the unprivileged user `cu`: the X server, the window manager, Chromium (restarted if it
# is closed) and the control server. The control secret stays in the control server only.
set -eu
export HOME=/tmp/home
mkdir -p "$HOME" /tmp/profile
W="${CU_WIDTH:-1280}"
H="${CU_HEIGHT:-800}"

env -u CU_SECRET Xvfb :99 -screen 0 "${W}x${H}x24" -nolisten tcp -dpi 96 >/tmp/xvfb.log 2>&1 &
i=0
while [ ! -e /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  [ "$i" -gt 100 ] && { echo "[cu] Xvfb did not start" >&2; cat /tmp/xvfb.log >&2; exit 1; }
  sleep 0.1
done

env -u CU_SECRET openbox --config-file /opt/cu/openbox.xml >/tmp/openbox.log 2>&1 &

CHROMIUM=$(command -v chromium || command -v chromium-browser)
(
  while true; do
    env -u CU_SECRET "$CHROMIUM" \
      --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu \
      --no-first-run --no-default-browser-check --disable-default-apps \
      --disable-sync --disable-background-networking --disable-component-update \
      --disable-features=Translate,MediaRouter,OptimizationHints,PasswordManagerOnboarding,AutofillServerCommunication \
      --password-store=basic --use-mock-keychain --noerrdialogs \
      --disable-session-crashed-bubble --hide-crash-restore-bubble \
      --user-data-dir=/tmp/profile --lang=en-US \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
      --window-position=0,0 --window-size="${W},${H}" --force-device-scale-factor=1 \
      about:blank >>/tmp/chromium.log 2>&1 || true
    sleep 1
  done
) &

exec python3 /opt/cu/server.py
