#!/usr/bin/env python3
"""Control server inside the Allowance computer-use desktop (docs/ARCHITECTURE.md §19).

Only the computer-use service talks to it, with the per-container secret in X-CU-Secret (pages in
the browser cannot send that header, and the egress firewall keeps other containers out).

  GET  /health                       {ok, browser}
  GET  /snapshot                     visible text + numbered interactive elements (JSON)
  GET  /screenshot?format=png|jpeg   the screen
  GET  /stream                       live MJPEG (multipart/x-mixed-replace)
  POST /action                       {kind, ...} -> {ok, url, title, ...} or {error, message}

Input goes through xdotool (real X events, the pointer moves on the stream); navigation, page text
and element geometry come from Chromium's DevTools protocol on 127.0.0.1:9222.
"""
import hmac
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import websocket  # py3-websocket-client

SECRET = os.environ.pop("CU_SECRET", "")
W = int(os.environ.get("CU_WIDTH", "1280"))
H = int(os.environ.get("CU_HEIGHT", "800"))
DISPLAY = os.environ.get("DISPLAY", ":99")
CDP_HTTP = "http://127.0.0.1:9222"
PORT = 8080
with open("/opt/cu/snapshot.js", encoding="utf-8") as f:
    PAGE_JS = f.read()

X_ENV = {"DISPLAY": DISPLAY, "HOME": os.environ.get("HOME", "/tmp/home"), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}


class ActionError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def log(msg):
    print(f"[cu] {msg}", flush=True)


# ---------------------------------------------------------------- Chromium DevTools protocol


class Cdp:
    def __init__(self):
        self.lock = threading.RLock()
        self.ws = None
        self.target = None
        self.seq = 0

    def _targets(self):
        with urllib.request.urlopen(CDP_HTTP + "/json/list", timeout=3) as r:
            return json.load(r)

    def _page(self):
        try:
            pages = [t for t in self._targets() if t.get("type") == "page" and not str(t.get("url", "")).startswith("devtools://")]
        except Exception as e:
            raise ActionError(503, "browser_unavailable", f"The browser isn't answering yet ({e}).")
        if not pages:
            req = urllib.request.Request(CDP_HTTP + "/json/new?about:blank", method="PUT")
            with urllib.request.urlopen(req, timeout=5) as r:
                pages = [json.load(r)]
        return pages[0]

    def _close(self):
        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:
                pass
        self.ws, self.target = None, None

    def _send(self, method, params=None, timeout=20):
        self.seq += 1
        mid = self.seq
        self.ws.settimeout(timeout)
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while True:
            if time.time() > deadline:
                raise ActionError(504, "browser_timeout", f"The browser did not answer {method} in time.")
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise ActionError(502, "browser_error", f"{method}: {msg['error'].get('message', 'error')}")
                return msg.get("result", {})

    def call(self, method, params=None, timeout=20):
        with self.lock:
            for attempt in (1, 2):
                page = self._page()
                if self.ws is None or self.target != page["id"]:
                    self._close()
                    self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
                    self.target = page["id"]
                    self._send("Page.addScriptToEvaluateOnNewDocument", {"source": PAGE_JS})
                try:
                    return self._send(method, params, timeout)
                except (websocket.WebSocketException, OSError, ConnectionError):
                    self._close()
                    if attempt == 2:
                        raise ActionError(503, "browser_unavailable", "Lost the connection to the browser.")

    def evaluate(self, expression, timeout=20):
        r = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}, timeout)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            text = (d.get("exception") or {}).get("description") or d.get("text") or "script error"
            raise ActionError(502, "page_script_failed", f"Reading the page failed: {text[:200]}")
        return (r.get("result") or {}).get("value")

    def page_call(self, fn_call, timeout=20):
        """Run a window.__cu helper (re-injected, since a navigation clears it)."""
        return self.evaluate(f"(() => {{ if (!window.__cu) {{ {PAGE_JS} }} return {fn_call}; }})()", timeout)

    def wait_loaded(self, timeout=15.0, settle=0.3):
        deadline = time.time() + timeout
        time.sleep(settle)
        while time.time() < deadline:
            try:
                if self.evaluate("document.readyState", 5) == "complete":
                    return True
            except ActionError:
                pass
            time.sleep(0.25)
        return False

    def location(self):
        try:
            v = self.evaluate("({url: location.href, title: document.title})", 5) or {}
            return {"url": v.get("url", ""), "title": (v.get("title") or "")[:120]}
        except ActionError:
            return {"url": "", "title": ""}

    def healthy(self):
        try:
            with urllib.request.urlopen(CDP_HTTP + "/json/version", timeout=2) as r:
                json.load(r)
            return True
        except Exception:
            return False


cdp = Cdp()

# --------------------------------------------------------------------- X input (xdotool)


def xdo(*args, timeout=15):
    r = subprocess.run(["xdotool", *[str(a) for a in args]], env=X_ENV, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise ActionError(502, "input_failed", f"xdotool {args[0]} failed: {r.stderr.strip()[:200]}")


KEY_ALIASES = {
    "enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape", "tab": "Tab", "space": "space",
    "backspace": "BackSpace", "delete": "Delete", "del": "Delete", "up": "Up", "down": "Down", "left": "Left",
    "right": "Right", "arrowup": "Up", "arrowdown": "Down", "arrowleft": "Left", "arrowright": "Right",
    "pageup": "Page_Up", "pagedown": "Page_Down", "page_up": "Page_Up", "page_down": "Page_Down", "home": "Home",
    "end": "End", "ctrl": "ctrl", "control": "ctrl", "shift": "shift", "alt": "alt", "meta": "super", "cmd": "super",
    "super": "super", "insert": "Insert",
}
KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,20}$")


def keysyms(spec):
    """'ctrl+l', 'Enter', 'Tab Tab Enter' -> xdotool key arguments."""
    combos = [c for c in re.split(r"\s+", str(spec).strip()) if c]
    if not combos or len(combos) > 10:
        raise ActionError(400, "invalid_keys", 'Give keys like "Enter", "ctrl+a" or "Tab Tab Enter" (at most 10).')
    out = []
    for combo in combos:
        parts = []
        for k in combo.split("+"):
            if not KEY_RE.match(k):
                raise ActionError(400, "invalid_keys", f'"{k}" is not a key name. Use names like Enter, Tab, Escape, ctrl+a, Page_Down, F5.')
            parts.append(KEY_ALIASES.get(k.lower(), k if len(k) > 1 else k))
        out.append("+".join(parts))
    return out


def element_point(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        raise ActionError(400, "invalid_element", "element must be a number from the last snapshot.")
    r = cdp.page_call(f"window.__cu.locate({n})") or {}
    err = r.get("error")
    if err == "stale_snapshot":
        raise ActionError(409, "stale_snapshot", "The page changed since the last snapshot; take a new snapshot and use its numbers.")
    if err == "element_not_found":
        raise ActionError(404, "element_not_found", f"There is no element {n} in the last snapshot ({r.get('count', 0)} elements).")
    if err == "element_not_visible":
        raise ActionError(409, "element_not_visible", f"Element {n} can't be shown on screen right now.")
    return r


def point_from(body):
    if body.get("element") is not None:
        r = element_point(body["element"])
        return r["x"], r["y"], r
    if body.get("x") is not None and body.get("y") is not None:
        try:
            x, y = int(body["x"]), int(body["y"])
        except (TypeError, ValueError):
            raise ActionError(400, "invalid_point", "x and y must be whole screen pixels.")
        if not (0 <= x < W and 0 <= y < H):
            raise ActionError(400, "invalid_point", f"x,y must be on the {W}x{H} screen.")
        return x, y, None
    return None


def after_input(before_url):
    """Give the page a moment; if a click or key started a navigation, wait for it to load."""
    time.sleep(0.35)
    loc = cdp.location()
    if loc["url"] != before_url:
        cdp.wait_loaded(10, settle=0)
        loc = cdp.location()
    return loc


def do_action(body):
    kind = str(body.get("kind", ""))
    if kind == "navigate":
        url = str(body.get("url", "")).strip()
        if not re.match(r"^https?://", url, re.I):
            if re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I) and not re.match(r"^[\w.-]+:\d+", url):
                raise ActionError(400, "invalid_url", "Only http(s) URLs can be opened.")
            url = "https://" + url
        if len(url) > 2000:
            raise ActionError(400, "invalid_url", "That URL is too long.")
        r = cdp.call("Page.navigate", {"url": url}, 30)
        if r.get("errorText"):
            raise ActionError(422, "navigation_failed", f"Couldn't open {url}: {r['errorText']}.")
        loaded = cdp.wait_loaded(15)
        loc = cdp.location()
        return {**loc, **({} if loaded else {"note": "The page is still loading."})}

    if kind in ("back", "forward"):
        before = cdp.location()["url"]
        cdp.evaluate("history.back()" if kind == "back" else "history.forward()", 5)
        time.sleep(0.4)
        cdp.wait_loaded(10, settle=0)
        loc = cdp.location()
        return {**loc, **({"note": "Nothing to go " + kind + " to."} if loc["url"] == before else {})}

    if kind == "reload":
        cdp.call("Page.reload", {}, 15)
        cdp.wait_loaded(15)
        return cdp.location()

    if kind in ("click", "hover"):
        before = cdp.location()["url"]
        p = point_from(body)
        if not p:
            raise ActionError(400, "invalid_target", f"{kind} needs element (a number from the snapshot) or x and y.")
        x, y, info = p
        button = {"left": 1, "middle": 2, "right": 3}.get(str(body.get("button", "left")), None)
        if button is None:
            raise ActionError(400, "invalid_button", 'button is "left", "middle" or "right".')
        xdo("mousemove", "--sync", x, y)
        if kind == "click":
            count = 2 if int(body.get("count", 1) or 1) == 2 else 1
            xdo("click", "--repeat", count, "--delay", 80, button)
        loc = after_input(before)
        out = {**loc, "x": x, "y": y}
        if info:
            out["clicked" if kind == "click" else "hovered"] = f"[{body['element']}] {info.get('label') or info.get('role')}"
        return out

    if kind == "type":
        text = body.get("text")
        if not isinstance(text, str) or not text:
            raise ActionError(400, "invalid_text", "type needs text.")
        if len(text) > 2000:
            raise ActionError(400, "invalid_text", "text can be at most 2000 characters.")
        before = cdp.location()["url"]
        info = None
        if body.get("element") is not None or body.get("x") is not None:
            x, y, info = point_from(body)
            xdo("mousemove", "--sync", x, y)
            xdo("click", 1)
            time.sleep(0.15)
        if body.get("clear"):
            xdo("key", "--clearmodifiers", "ctrl+a", "BackSpace")
        xdo("type", "--clearmodifiers", "--delay", 12, "--", text, timeout=60)
        if body.get("submit"):
            xdo("key", "--clearmodifiers", "Return")
        loc = after_input(before)
        out = {**loc, "typed": len(text)}
        if info:
            out["into"] = f"[{body['element']}] {info.get('label') or info.get('role')}"
        return out

    if kind == "key":
        before = cdp.location()["url"]
        keys = keysyms(body.get("keys", ""))
        xdo("key", "--clearmodifiers", "--delay", 40, *keys)
        loc = after_input(before)
        return {**loc, "keys": " ".join(keys)}

    if kind == "scroll":
        direction = str(body.get("direction", "down"))
        btn = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction)
        if not btn:
            raise ActionError(400, "invalid_direction", 'direction is "up", "down", "left" or "right".')
        try:
            amount = max(1, min(15, int(body.get("amount", 5))))
        except (TypeError, ValueError):
            raise ActionError(400, "invalid_amount", "amount is 1-15 wheel steps.")
        p = point_from(body)
        x, y = (p[0], p[1]) if p else (W // 2, min(H - 10, H // 2 + 40))
        xdo("mousemove", "--sync", x, y)
        xdo("click", "--repeat", amount, "--delay", 25, btn)
        time.sleep(0.3)
        pos = cdp.evaluate("({y: Math.round(scrollY), maxY: Math.max(0, Math.round((document.scrollingElement||document.documentElement).scrollHeight - innerHeight))})", 5) or {}
        return {**cdp.location(), "scroll": pos}

    if kind == "select":
        if body.get("element") is None or body.get("value") is None:
            raise ActionError(400, "invalid_target", "select needs element (a <select> from the snapshot) and value.")
        try:
            n = int(body["element"])
        except (TypeError, ValueError):
            raise ActionError(400, "invalid_element", "element must be a number from the last snapshot.")
        r = cdp.page_call(f"window.__cu.select({n}, {json.dumps(str(body['value']))})") or {}
        err = r.get("error")
        if err == "stale_snapshot":
            raise ActionError(409, "stale_snapshot", "The page changed since the last snapshot; take a new snapshot and use its numbers.")
        if err == "element_not_found":
            raise ActionError(404, "element_not_found", f"There is no element {n} in the last snapshot.")
        if err == "not_a_select":
            raise ActionError(422, "not_a_select", f"Element {n} is a {r.get('role')}, not a dropdown; click it instead.")
        if err == "option_not_found":
            raise ActionError(422, "option_not_found", f"Element {n} has no option like that.", options=r.get("options", []))
        return {**cdp.location(), "selected": r.get("selected")}

    raise ActionError(400, "unknown_action", f'Unknown action "{kind}".')


# --------------------------------------------------------------------- screen capture


def grab(fmt):
    codec = ["-c:v", "png"] if fmt == "png" else ["-c:v", "mjpeg", "-q:v", "4"]
    cmd = ["ffmpeg", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-video_size", f"{W}x{H}", "-i", DISPLAY, "-frames:v", "1", *codec, "-f", "image2pipe", "-"]
    r = subprocess.run(cmd, env=X_ENV, capture_output=True, timeout=15)
    if r.returncode != 0 or not r.stdout:
        raise ActionError(502, "screenshot_failed", f"Couldn't capture the screen: {r.stderr.decode(errors='replace').strip()[:200]}")
    return r.stdout


class Streamer:
    """One ffmpeg x11grab for every viewer; it starts with the first viewer and stops when idle."""

    def __init__(self, fps=6):
        self.fps = fps
        self.cond = threading.Condition()
        self.frame = None
        self.frame_at = 0.0
        self.seq = 0
        self.viewers = 0
        self.proc = None
        self.last_use = 0.0

    def _run(self):
        cmd = ["ffmpeg", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-framerate", str(self.fps), "-video_size", f"{W}x{H}", "-i", DISPLAY,
               "-c:v", "mjpeg", "-q:v", "7", "-f", "image2pipe", "-"]
        proc = subprocess.Popen(cmd, env=X_ENV, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.proc = proc
        buf = b""
        try:
            while True:
                chunk = proc.stdout.read1(65536) if hasattr(proc.stdout, "read1") else proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                while True:
                    s = buf.find(b"\xff\xd8")
                    if s < 0:
                        buf = b""
                        break
                    e = buf.find(b"\xff\xd9", s + 2)
                    if e < 0:
                        buf = buf[s:]
                        break
                    with self.cond:
                        self.frame = buf[s:e + 2]
                        self.frame_at = time.time()
                        self.seq += 1
                        self.cond.notify_all()
                    buf = buf[e + 2:]
                with self.cond:
                    idle = self.viewers == 0 and time.time() - self.last_use > 10
                if idle:
                    break
        finally:
            proc.kill()
            proc.wait()
            with self.cond:
                self.proc = None
                self.cond.notify_all()

    def _ensure(self):
        with self.cond:
            self.last_use = time.time()
            if self.proc is None:
                self.proc = True  # placeholder until the thread sets it
                threading.Thread(target=self._run, daemon=True).start()

    def next_frame(self, after_seq, timeout=3.0):
        self._ensure()
        deadline = time.time() + timeout
        with self.cond:
            while self.seq <= after_seq:
                left = deadline - time.time()
                if left <= 0:
                    return None, after_seq
                self.cond.wait(left)
            return self.frame, self.seq

    def fresh_jpeg(self):
        """A frame captured after this call, if the stream is already running."""
        with self.cond:
            running = self.proc is not None
            seq = self.seq
        if not running:
            return None
        frame, _ = self.next_frame(seq, 1.5)
        return frame


streamer = Streamer()

# --------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "allowance-cu/1"

    def log_message(self, fmt, *args):  # quiet; the service logs requests
        pass

    def _authorized(self):
        got = self.headers.get("X-CU-Secret", "")
        return bool(SECRET) and hmac.compare_digest(got.encode(), SECRET.encode())

    def _json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _error(self, e):
        self._json(e.status, {"error": e.code, "message": e.message, **e.extra})

    def do_GET(self):
        if not self._authorized():
            return self._json(401, {"error": "unauthorized", "message": "Missing or wrong control secret."})
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/health":
                return self._json(200, {"ok": True, "browser": cdp.healthy(), "screen": {"width": W, "height": H}})
            if u.path == "/snapshot":
                snap = cdp.page_call("window.__cu.snapshot(5000, 120)", 20)
                if not isinstance(snap, dict):
                    raise ActionError(502, "snapshot_failed", "The page did not return a snapshot.")
                return self._json(200, snap)
            if u.path == "/screenshot":
                fmt = (q.get("format") or ["jpeg"])[0]
                fmt = "png" if fmt == "png" else "jpeg"
                data = streamer.fresh_jpeg() if fmt == "jpeg" else None
                data = data or grab(fmt)
                self.send_response(200)
                self.send_header("Content-Type", "image/png" if fmt == "png" else "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            if u.path == "/stream":
                return self._stream()
            return self._json(404, {"error": "not_found", "message": u.path})
        except ActionError as e:
            return self._error(e)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # never leak a traceback to the page
            log(f"GET {u.path} failed: {e!r}")
            return self._json(500, {"error": "desktop_error", "message": "The desktop hit an internal error."})

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        with streamer.cond:
            streamer.viewers += 1
        seq = 0
        try:
            misses = 0
            while True:
                frame, seq = streamer.next_frame(seq, 5.0)
                if frame is None:
                    misses += 1
                    if misses > 3:
                        break
                    continue
                misses = 0
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with streamer.cond:
                streamer.viewers -= 1
                streamer.last_use = time.time()

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"error": "unauthorized", "message": "Missing or wrong control secret."})
        u = urllib.parse.urlparse(self.path)
        if u.path != "/action":
            return self._json(404, {"error": "not_found", "message": u.path})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 64 * 1024:
                raise ActionError(413, "too_large", "Action body too large.")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ActionError(400, "invalid_action", "Send a JSON object.")
            with ACTION_LOCK:
                result = do_action(body)
            return self._json(200, {"ok": True, **result})
        except ActionError as e:
            return self._error(e)
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid_action", "message": "Body is not JSON."})
        except subprocess.TimeoutExpired:
            return self._json(504, {"error": "input_timeout", "message": "The input took too long."})
        except Exception as e:
            log(f"action failed: {e!r}")
            return self._json(500, {"error": "desktop_error", "message": "The desktop hit an internal error."})


ACTION_LOCK = threading.Lock()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    if not SECRET:
        log("CU_SECRET is not set; refusing to start")
        raise SystemExit(1)
    log(f"control server on :{PORT} ({W}x{H})")
    Server(("0.0.0.0", PORT), Handler).serve_forever()
