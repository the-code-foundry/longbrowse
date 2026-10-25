#!/bin/sh
# HEADLESS=1: no display at all. Otherwise Chromium runs headful on an Xvnc display,
# viewable in a browser via noVNC (websockify) on port 6080 (publish loopback-only).
set -e
if [ "$HEADLESS" = "1" ]; then
  exec node core/server.js
fi
# docker restart keeps the container fs: a stale X lock would kill Xvnc
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
if [ -n "$VNC_PASSWORD" ]; then
  # VNC auth file: password DES-encrypted with the fixed VNC key (first 8 chars
  # count). The image's tigervnc ships no vncpasswd, so node writes it.
  node --openssl-legacy-provider -e '
    const c = require("node:crypto");
    const pw = Buffer.alloc(8);
    Buffer.from(process.env.VNC_PASSWORD).copy(pw, 0, 0, 8);
    const ci = c.createCipheriv("des-ecb", Buffer.from("e84ad660c4721ae0", "hex"), null);
    ci.setAutoPadding(false);
    require("node:fs").writeFileSync("/tmp/vncpass", ci.update(pw), { mode: 0o600 });'
  SEC="-SecurityTypes VncAuth -PasswordFile /tmp/vncpass"
else
  SEC="-SecurityTypes None"
fi
# shellcheck disable=SC2086 # SEC is two words on purpose
Xvnc :99 -geometry "${SCREEN:-1280x720}" -depth 24 $SEC -localhost &
websockify --web /usr/share/novnc 6080 localhost:5999 &
export DISPLAY=:99
exec node core/server.js
