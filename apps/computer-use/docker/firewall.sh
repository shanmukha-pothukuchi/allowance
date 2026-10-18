#!/bin/sh
# Egress firewall for the desktop's own network namespace. The internet is allowed (it is for
# browsing); the host, its localhost services, other containers and the LAN are not.
set -eu

ipt() { iptables -w 5 "$@"; }

ipt -F OUTPUT
ipt -P OUTPUT ACCEPT
# The container's own loopback: the control server, Chromium's debugging port, the X server.
ipt -A OUTPUT -o lo -j ACCEPT
# Replies to connections the service opened to the control server.
ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# The Docker gateway is the host. Block it by address whatever range Docker uses.
gw=$(ip route 2>/dev/null | awk '/^default/ { print $3; exit }')
if [ -n "${gw:-}" ]; then
  ipt -A OUTPUT -d "$gw" -p tcp -j REJECT --reject-with tcp-reset
  ipt -A OUTPUT -d "$gw" -j REJECT
fi
# Every private, loopback, link-local, shared (CGNAT, e.g. Tailscale) and multicast range.
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
           192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  ipt -A OUTPUT -d "$net" -p tcp -j REJECT --reject-with tcp-reset
  ipt -A OUTPUT -d "$net" -j REJECT
done

# IPv6 is disabled by the service (sysctl); drop it here too in case it isn't.
if command -v ip6tables >/dev/null 2>&1 && ip6tables -w 5 -L OUTPUT >/dev/null 2>&1; then
  ip6tables -w 5 -F OUTPUT
  ip6tables -w 5 -A OUTPUT -o lo -j ACCEPT
  ip6tables -w 5 -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -w 5 -P OUTPUT DROP
fi

# Check the rules are really there before anything untrusted starts.
ipt -S OUTPUT | grep -q -- "-d 172.16.0.0/12" || exit 1
ipt -S OUTPUT | grep -q -- "-d 127.0.0.0/8" || exit 1
echo "[cu] firewall up (gateway ${gw:-none} blocked)" >&2
