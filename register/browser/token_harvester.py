"""Browser-only token harvest for Castle / Turnstile (hybrid mode)."""
from __future__ import annotations

import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


@dataclass
class HarvestedTokens:
    turnstile: str = ""
    castle: str = ""
    page_url: str = ""
    cookies: dict = field(default_factory=dict)
    next_action: str = ""


class BrowserTokenSession:
    """One Chromium session dedicated to token / cookie harvest."""

    def __init__(self, log: Optional[Callable[[str], None]] = None):
        self.log = log or (lambda _m: None)
        self._started = False
        self._hooked = False
        self._listen_started = False

    def _lg(self, msg: str):
        try:
            self.log(msg)
        except Exception:
            pass

    def start(self):
        from grok_register_ttk import start_browser

        start_browser(log_callback=self.log)
        self._started = True
        return self

    def install_network_hook(self) -> bool:
        """Capture castleRequestToken from native React fetch/XHR bodies.

        Also starts DrissionPage network listener (CDP) as a side channel:
        gRPC-web CreateEmail often uses binary body; JS fetch hooks alone miss it.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            self._lg("[Debug] net hook: page is None")
            return False
        try:
            res = page.run_js(
                r"""
(function(){
  if (window.__hybrid_net_hooked) return 'already';
  window.__hybrid_net_hooked = true;
  window.__hybrid_castles = window.__hybrid_castles || [];
  window.__hybrid_castle = window.__hybrid_castle || '';
  window.__hybrid_net = window.__hybrid_net || [];
  window.__hybrid_create_email_ok = false;
  window.__hybrid_create_email_status = 0;
  window.__hybrid_create_email_seen = false;

  function pushCastle(tok) {
    try {
      const s = String(tok || '');
      if (s.length < 200) return;
      window.__hybrid_castle = s;
      window.__hybrid_castles.push(s);
    } catch (e) {}
  }

  function extractCastleFromText(s) {
    if (!s || typeof s !== 'string') return;
    if (s.includes('castleRequestToken')) {
      try {
        const j = JSON.parse(s);
        const tok = j && j[0] && j[0].castleRequestToken;
        if (tok) pushCastle(tok);
      } catch (e) {
        const m = s.match(/castleRequestToken["']?\s*:\s*["']([^"']{200,})/);
        if (m) pushCastle(m[1]);
      }
    }
    const m2 = s.match(/IBYIll\|[A-Za-z0-9+/=|_-]{200,}/);
    if (m2) pushCastle(m2[0]);
  }

  async function bodyToString(body) {
    try {
      if (!body) return '';
      if (typeof body === 'string') return body;
      // Prefer latin1 so protobuf binary keeps ASCII castle spans intact for regex
      function dec(buf) {
        try {
          return new TextDecoder('latin1').decode(buf);
        } catch (e) {
          try { return new TextDecoder().decode(buf); } catch (e2) { return ''; }
        }
      }
      if (body instanceof ArrayBuffer) return dec(body);
      if (ArrayBuffer.isView(body)) return dec(body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body);
      if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        try { return JSON.stringify(Array.from(body.entries())); } catch (e) { return ''; }
      }
      if (typeof Request !== 'undefined' && body instanceof Request) {
        try { return await body.clone().text(); } catch (e) { return ''; }
      }
      if (typeof body.text === 'function') {
        try { return await body.text(); } catch (e) {}
      }
    } catch (e) {}
    return '';
  }

  function captureBody(body, url) {
    try {
      const u = String(url || '');
      let rawLen = 0;
      try {
        if (typeof body === 'string') rawLen = body.length;
        else if (body instanceof ArrayBuffer) rawLen = body.byteLength || 0;
        else if (ArrayBuffer.isView(body)) rawLen = body.byteLength || 0;
        else if (typeof Blob !== 'undefined' && body instanceof Blob) rawLen = body.size || 0;
      } catch (e) {}
      Promise.resolve(bodyToString(body)).then(function(s) {
        try {
          const len = Math.max(rawLen || 0, (s && s.length) || 0);
          if (!s && !len) return;
          window.__hybrid_net.push({url: u, len: len});
          if (u.includes('CreateEmailValidationCode')) {
            window.__hybrid_create_email_seen = true;
            if (len > 0 && len < 200) {
              window.__hybrid_create_email_short = true;
            }
          }
          if (s) extractCastleFromText(s);
        } catch (e) {}
      });
    } catch (e) {}
  }

  const ofetch = window.fetch;
  window.fetch = async function(input, init) {
    let url = '';
    try {
      url = (typeof input === 'string')
        ? input
        : (input && (input.url || (input.href || ''))) || '';
      const body = (init && init.body != null)
        ? init.body
        : (typeof Request !== 'undefined' && input instanceof Request ? input : null);
      if (body != null) captureBody(body, url);
      else if (typeof Request !== 'undefined' && input instanceof Request) {
        try { captureBody(await input.clone().text(), url); } catch (e) {}
      }
    } catch (e) {}
    const resp = await ofetch.apply(this, arguments);
    try {
      if (String(url).includes('CreateEmailValidationCode')) {
        window.__hybrid_create_email_status = resp.status || 0;
        window.__hybrid_create_email_ok = !!(resp.ok || (resp.status >= 200 && resp.status < 300));
        window.__hybrid_create_email_seen = true;
      }
    } catch (e) {}
    return resp;
  };

  const oopen = XMLHttpRequest.prototype.open;
  const osend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) {
    this.__u = u;
    return oopen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    captureBody(body, this.__u);
    const xhr = this;
    try {
      xhr.addEventListener('load', function() {
        try {
          if (String(xhr.__u || '').includes('CreateEmailValidationCode')) {
            window.__hybrid_create_email_status = xhr.status || 0;
            window.__hybrid_create_email_ok = xhr.status >= 200 && xhr.status < 300;
            window.__hybrid_create_email_seen = true;
          }
        } catch (e) {}
      });
    } catch (e) {}
    return osend.apply(this, arguments);
  };
  return 'hooked';
})();
"""
            )
            # DrissionPage may return None for JS that ends with return inside IIFE.
            if res is None:
                probe = page.run_js(
                    "return window.__hybrid_net_hooked ? (window.__hybrid_net_hooked === true ? 'hooked' : String(window.__hybrid_net_hooked)) : 'missing';"
                )
                res = probe if probe not in (None, "missing") else "hooked"
            self._hooked = True
            self._lg(f"[*] net hook={res}")
        except Exception as e:
            self._lg(f"[Debug] net hook: {e}")
            self._hooked = False

        # CDP listener: reliable for request postData (JSON server-action + any post body)
        try:
            self._start_cdp_listener(page)
        except Exception as e:
            self._lg(f"[Debug] cdp listen: {e}")

        return self._hooked

    def _start_cdp_listener(self, page) -> bool:
        """Listen for CreateEmail / castle-bearing POSTs via DrissionPage listener."""
        if page is None:
            return False
        try:
            listen = getattr(page, "listen", None)
            if listen is None:
                return False
            if not getattr(listen, "listening", False):
                # Match CreateEmail RPC and signup server actions
                # substring match on request URL (not body). CreateEmail carries castle.
                listen.start(
                    targets=[
                        "CreateEmailValidationCode",
                        "AuthManagement",
                        "accounts.x.ai/sign-up",
                    ],
                    method=("POST",),
                    res_type=True,
                )
            else:
                try:
                    listen.set_targets(
                        targets=[
                            "CreateEmailValidationCode",
                            "AuthManagement",
                            "accounts.x.ai/sign-up",
                        ],
                        method=("POST",),
                        res_type=True,
                    )
                except Exception:
                    pass
            self._listen_started = True
            self._lg("[*] cdp listen=on")
            return True
        except Exception as e:
            self._lg(f"[Debug] cdp listen start: {e}")
            return False

    @staticmethod
    def _extract_castle_from_blob(blob) -> str:
        """Pull IBYIll / long castleRequestToken from post body / response."""
        if blob is None or blob is False:
            return ""
        if isinstance(blob, (bytes, bytearray)):
            raw = bytes(blob)
            # gRPC-web frame may be: 1 byte flags + 4 byte len + protobuf (email + castle)
            # Castle string is almost always plain ASCII inside protobuf.
            # Also try skipping 5-byte gRPC-web header then search remainder.
            candidates = [raw]
            if len(raw) > 5:
                candidates.append(raw[5:])
            for chunk in candidates:
                try:
                    m = re.search(rb"IBYIll\|[A-Za-z0-9+/=|_\-]{800,}", chunk)
                    if m:
                        return m.group(0).decode("ascii", errors="ignore")
                except Exception:
                    pass
                try:
                    m = re.search(rb"IBYIll\|[A-Za-z0-9+/=|_\-]{200,}", chunk)
                    if m:
                        return m.group(0).decode("ascii", errors="ignore")
                except Exception:
                    pass
            try:
                s = raw.decode("utf-8", errors="ignore")
            except Exception:
                try:
                    s = raw.decode("latin-1", errors="ignore")
                except Exception:
                    s = ""
            text = s
        elif isinstance(blob, dict):
            # parsed JSON
            try:
                import json as _json

                text = _json.dumps(blob, ensure_ascii=False)
            except Exception:
                text = str(blob)
            # direct path
            try:
                if isinstance(blob, list) and blob and isinstance(blob[0], dict):
                    tok = blob[0].get("castleRequestToken") or ""
                    if len(str(tok)) >= 200:
                        return str(tok)
                if isinstance(blob, dict):
                    tok = blob.get("castleRequestToken") or ""
                    if len(str(tok)) >= 200:
                        return str(tok)
            except Exception:
                pass
        else:
            text = str(blob)

        if not text:
            return ""
        if "castleRequestToken" in text:
            try:
                import json as _json

                j = _json.loads(text)
                if isinstance(j, list) and j and isinstance(j[0], dict):
                    tok = j[0].get("castleRequestToken") or ""
                    if len(str(tok)) >= 200:
                        return str(tok)
            except Exception:
                m = re.search(r'castleRequestToken["\']?\s*:\s*["\']([^"\']{200,})', text)
                if m:
                    return m.group(1)
        m2 = re.search(r"IBYIll\|[A-Za-z0-9+/=|_-]{200,}", text)
        if m2:
            return m2.group(0)
        return ""

    def _poll_cdp_castle(self) -> str:
        """Drain listener packets for castle token."""
        from grok_register_ttk import _get_page

        page = _get_page()
        if page is None:
            return ""
        listen = getattr(page, "listen", None)
        if listen is None or not getattr(listen, "listening", False):
            return ""
        best = ""
        try:
            # Non-blocking drain via private queue size if available
            q = getattr(listen, "_caught", None)
            n = 0
            if q is not None:
                try:
                    n = int(q.qsize())
                except Exception:
                    n = 0
            for _ in range(max(n, 0) + 3):
                try:
                    # wait with tiny timeout to avoid hang
                    pkt = listen.wait(count=1, timeout=0.05, fit_count=True, raise_err=False)
                except TypeError:
                    try:
                        pkt = listen.wait(1, 0.05)
                    except Exception:
                        break
                except Exception:
                    break
                if not pkt:
                    break
                try:
                    req = getattr(pkt, "request", None)
                    post = None
                    if req is not None:
                        for attr in (
                            "postData",
                            "body",
                            "data",
                            "postDataRaw",
                            "post_data",
                        ):
                            v = getattr(req, attr, None)
                            if v:
                                post = v
                                break
                        # some versions expose postData as method
                        if post is None and callable(getattr(req, "postData", None)):
                            try:
                                post = req.postData()
                            except Exception:
                                pass
                    # postData 过短时用 Network.getRequestPostData 补全（gRPC 常被截断）
                    if post is not None:
                        try:
                            plen0 = (
                                len(post)
                                if isinstance(post, (bytes, bytearray))
                                else len(str(post))
                            )
                        except Exception:
                            plen0 = 0
                    else:
                        plen0 = 0
                    if plen0 < 200:
                        rid = None
                        for attr in ("requestId", "request_id", "id"):
                            try:
                                rid = getattr(req, attr, None) if req is not None else None
                                if rid:
                                    break
                            except Exception:
                                pass
                        if not rid:
                            try:
                                rid = getattr(pkt, "requestId", None) or getattr(
                                    pkt, "request_id", None
                                )
                            except Exception:
                                rid = None
                        if rid:
                            try:
                                extra = page.run_cdp(
                                    "Network.getRequestPostData", requestId=str(rid)
                                )
                                if isinstance(extra, dict):
                                    pd = extra.get("postData") or extra.get("body")
                                    if pd:
                                        post = pd
                            except Exception:
                                pass
                    # 响应体也可能带回 castle 相关（少见，兜底）
                    c = self._extract_castle_from_blob(post)
                    if len(c) <= len(best):
                        try:
                            resp = getattr(pkt, "response", None)
                            rbody = None
                            if resp is not None:
                                for attr in ("body", "raw_body", "postData", "data"):
                                    v = getattr(resp, attr, None)
                                    if v:
                                        rbody = v
                                        break
                            if rbody:
                                c2 = self._extract_castle_from_blob(rbody)
                                if len(c2) > len(c):
                                    c = c2
                        except Exception:
                            pass
                    if len(c) > len(best):
                        best = c
                    url = str(getattr(pkt, "url", "") or "")
                    if "CreateEmailValidationCode" in url:
                        plen = 0
                        try:
                            if isinstance(post, (bytes, bytearray)):
                                plen = len(post)
                            elif post is not None:
                                plen = len(str(post))
                        except Exception:
                            plen = 0
                        if plen and plen < 200 and len(best) < 200:
                            self._lg(
                                f"[!] CDP CreateEmail postData still short len={plen} "
                                f"(castle missing in wire body)"
                            )
                        elif len(best) >= 200:
                            self._lg(
                                f"[*] CDP CreateEmail castle recovered len={len(best)}"
                            )
                        try:
                            page.run_js(
                                "window.__hybrid_create_email_seen=true; true;"
                            )
                        except Exception:
                            pass
                except Exception:
                    pass
        except Exception as e:
            self._lg(f"[Debug] cdp poll: {e}")
        if best and len(best) >= 200:
            # mirror into page globals for create_email_sent_via_browser
            try:
                page.run_js(
                    """
const t = String(arguments[0] || '');
if (t.length > 200) {
  window.__hybrid_castle = t;
  window.__hybrid_castles = window.__hybrid_castles || [];
  window.__hybrid_castles.push(t);
  window.__hybrid_create_email_seen = true;
}
true;
""",
                    best,
                )
            except Exception:
                pass
            return best
        return ""

    def create_email_sent_via_browser(self) -> bool:
        """Strict: only skip protocol CreateEmail when browser request truly succeeded.

        Do NOT treat "captured castle" alone as success — that caused false skip → no mail code.
        """
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            data = page.run_js(
                """
return {
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  seen: !!window.__hybrid_create_email_seen,
  castle: (window.__hybrid_castle||'').length
};
"""
            )
            if isinstance(data, dict):
                ok = bool(data.get("ok"))
                status = int(data.get("status") or 0)
                seen = bool(data.get("seen"))
                # Explicit success only
                if ok and (status == 0 or (200 <= status < 300)):
                    return True
                if seen and status == 200:
                    return True
                self._lg(
                    f"[*] CreateEmail browser status: ok={ok} status={status} "
                    f"seen={seen} castle_len={data.get('castle')}"
                )
        except Exception as e:
            self._lg(f"[*] CreateEmail browser status probe fail: {e}")
        return False

    def browser_user_agent(self) -> str:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            ua = page.run_js("return navigator.userAgent || ''")
            return str(ua or "").strip()
        except Exception:
            return ""

    def read_captured_castle(self) -> str:
        from grok_register_ttk import _get_page

        # Prefer CDP side-channel first (binary gRPC postData)
        cdp = self._poll_cdp_castle()
        if cdp and len(cdp) >= 1000:
            return cdp
        if cdp and len(cdp) >= 800 and cdp.startswith("IBYIll"):
            return cdp

        page = _get_page()
        try:
            data = page.run_js(
                """
const list = window.__hybrid_castles || [];
let best = window.__hybrid_castle || '';
for (const t of list) {
  if (String(t||'').length > String(best||'').length) best = t;
}
return {
  castle: String(best||''),
  n: list.length,
  net: (window.__hybrid_net||[]).length,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0)
};
"""
            )
            if isinstance(data, dict):
                c = str(data.get("castle") or "")
                if len(c) >= 1000 and c.startswith("IBYIll"):
                    return c
                if len(c) >= 2000:
                    return c
                if len(c) >= 800 and c.startswith("IBYIll"):
                    return c
        except Exception:
            pass
        if cdp and len(cdp) >= 800:
            return cdp
        return ""


    def _kick_page_castle_mint(self, page) -> None:
        """Try native/page Castle APIs before clicking 注册.

        Logs show CreateEmail body ~33B (email only) when React submits before
        useCastle() finishes. Kick mint early so IBYIll may land in hooks/DOM.
        """
        if page is None:
            return
        pk = ""
        try:
            pk = self._extract_castle_pk() or ""
        except Exception:
            pk = ""
        try:
            page.run_js(
                r"""
const pk = String(arguments[0] || '');
window.__hybrid_castle = window.__hybrid_castle || '';
window.__hybrid_castles = window.__hybrid_castles || [];
window.__hybrid_castle_status = window.__hybrid_castle_status || '';
function pushTok(t) {
  const s = String(t || '');
  if (s.length < 40) return;
  window.__hybrid_castle = s;
  window.__hybrid_castles.push(s);
  window.__hybrid_castle_status = s.indexOf('IBYIll|') === 0 ? 'native-ish' : 'minted';
}
function tryMint(api, label) {
  try {
    let a = api;
    if (a && a.default) a = a.default;
    if (a && typeof a.configure === 'function' && pk) {
      try { a.configure({ pk: pk }); } catch (e0) {}
    }
    let fn = null;
    if (a && typeof a.createRequestToken === 'function') fn = a.createRequestToken.bind(a);
    if (!fn && typeof api === 'function') {
      try {
        const inst = pk ? api({ pk: pk }) : api();
        if (inst && typeof inst.createRequestToken === 'function')
          fn = inst.createRequestToken.bind(inst);
      } catch (e1) {}
    }
    if (!fn) return false;
    window.__hybrid_castle_status = 'minting:' + label;
    Promise.resolve(fn()).then(function (t) { pushTok(t); }).catch(function (e) {
      window.__hybrid_castle_err = String(e);
      window.__hybrid_castle_status = 'error:' + label;
    });
    return true;
  } catch (e) {
    return false;
  }
}
// 1) globals
let hit = false;
const g = [window.Castle, window.castle, window['@castleio/castle-js']];
for (let i = 0; i < g.length; i++) {
  if (g[i] && tryMint(g[i], 'global' + i)) hit = true;
}
// 2) webpack module cache scan (best-effort; no CDN inject)
try {
  const keys = Object.keys(window).filter(function (k) {
    return /^webpackChunk|^__NEXT_DATA__|^__webpack/.test(k);
  });
  // walk require.cache-like if present
  if (typeof window.webpackChunk_N_E !== 'undefined') {
    /* Next may not expose castle here */
  }
} catch (e) {}
// 3) hidden inputs / data attributes already filled by React
try {
  for (const el of document.querySelectorAll('input,textarea,[data-castle]')) {
    const v = String((el.value || el.getAttribute('data-castle') || el.textContent || ''));
    if (v.indexOf('IBYIll|') === 0 && v.length > 200) pushTok(v);
  }
} catch (e) {}
// 4) nudge React: focus email + input event (useCastle often ties to field activity)
try {
  const input = document.querySelector(
    'input[data-testid="email"], input[name="email"], input[type="email"]'
  );
  if (input) {
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }
} catch (e) {}
return {
  hit: hit,
  status: String(window.__hybrid_castle_status || ''),
  len: String(window.__hybrid_castle || '').length
};
""",
                pk,
            )
        except Exception as e:
            self._lg(f"[Debug] kick castle mint: {e}")

    def _wait_castle_ready_before_submit(self, page, max_wait: float = 10.0) -> None:
        """Kick mint + poll for long IBYIll castle before clicking 注册.

        Sites often have no window.Castle (sdk=False). AA logs show 10s+8s waits
        with len=0 forever — early-abort after a short probe to save ~15–20s/round.
        """
        try:
            self._kick_page_castle_mint(page)
        except Exception:
            pass
        max_wait = max(1.0, float(max_wait or 10))
        deadline = time.time() + max_wait
        last = ""
        kicked = 1
        saw_sdk_or_mint = False
        empty_polls = 0
        while time.time() < deadline:
            try:
                data = page.run_js(
                    r"""
let best = '';
try {
  if (window.__hybrid_castle) best = String(window.__hybrid_castle);
  for (const t of (window.__hybrid_castles||[])) {
    if (String(t||'').length > best.length) best = String(t);
  }
} catch (e) {}
try {
  for (const el of document.querySelectorAll('input,textarea')) {
    const v = String(el.value || '');
    if (v.includes('IBYIll|') && v.length > best.length) best = v;
  }
} catch (e) {}
let sdk = false;
try {
  const C = window.Castle || window.castle || null;
  sdk = !!(C && (C.createRequestToken || (C.default && C.default.createRequestToken)));
} catch (e) {}
return {
  len: best.length,
  head: best.slice(0, 12),
  sdk: sdk,
  status: String(window.__hybrid_castle_status || '')
};
"""
                )
                if isinstance(data, dict):
                    ln = int(data.get("len") or 0)
                    sdk = bool(data.get("sdk"))
                    st = str(data.get("status") or "")
                    s = f"len={ln} sdk={sdk} st={st}"
                    if s != last:
                        self._lg(f"[*] pre-submit castle wait: {s}")
                        last = s
                    if sdk or st.startswith("minting") or st in ("native-ish", "minted", "done"):
                        saw_sdk_or_mint = True
                    if ln >= 1000 and str(data.get("head") or "").startswith("IBYIll"):
                        self._lg(f"[*] pre-submit castle ready len={ln}")
                        return
                    if ln >= 2000:
                        self._lg(f"[*] pre-submit castle ready (long) len={ln}")
                        return
                    if ln < 40 and not sdk and not st.startswith("minting"):
                        empty_polls += 1
                        # ~1.2s of empty polls with no SDK → bail early
                        if empty_polls >= 4 and not saw_sdk_or_mint:
                            self._lg(
                                "[*] pre-submit castle: no page SDK / token — "
                                "skip long wait (site may send CreateEmail without castle)"
                            )
                            return
                    else:
                        empty_polls = 0
                        # mid-wait re-kick only when SDK or mint activity exists
                        if (
                            kicked < 2
                            and saw_sdk_or_mint
                            and ln < 800
                            and (deadline - time.time()) < (max_wait * 0.45)
                        ):
                            self._kick_page_castle_mint(page)
                            kicked += 1
            except Exception:
                pass
            time.sleep(0.3)

    def _click_register_button(self, page) -> str:
        try:
            return str(
                page.run_js(
                    r"""
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
const buttons = Array.from(document.querySelectorAll('button[type="submit"], button')).filter((node) => {
  return isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
});
let submitButton = buttons.find((node) => {
  const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
  const t = text.toLowerCase();
  return text === '注册' || text.includes('注册') || t === 'signup' || t.includes('signup') || t.includes('sign up');
});
if (!submitButton) {
  submitButton = buttons.find((node) => {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
    const t = text.toLowerCase();
    return text.includes('继续') || t.includes('continue') || t.includes('next') || node.type === 'submit';
  });
}
if (!submitButton) return 'no-button';
submitButton.click();
return 'submitted';
"""
                )
                or ""
            )
        except Exception as e:
            return f"click-err:{e}"


    def harvest_castle_via_email_submit(self, email: str, timeout: int = 40) -> str:
        """Trigger React useCastle() by submitting email in UI; capture ~14KB token.

        Aligns fill/submit with Plan A (fill_email_and_submit): native value setter,
        blur, short settle, then click 注册 (not 继续/Continue which may match wrong btn).
        """
        from grok_register_ttk import _get_page

        if not self._hooked:
            self.install_network_hook()
        else:
            # re-assert hook after SPA navigations
            try:
                page0 = _get_page()
                st = page0.run_js("return !!window.__hybrid_net_hooked;") if page0 else False
                if not st:
                    self._hooked = False
                    self.install_network_hook()
            except Exception:
                self.install_network_hook()
        page = _get_page()
        if page is None:
            self._lg("[!] harvest castle: page is None")
            return ""

        # clear previous capture state
        try:
            page.run_js(
                """
window.__hybrid_castle='';
window.__hybrid_castles=[];
window.__hybrid_net=[];
window.__hybrid_create_email_ok=false;
window.__hybrid_create_email_status=0;
window.__hybrid_create_email_seen=false;
true;
"""
            )
        except Exception:
            pass
        try:
            listen = getattr(page, "listen", None)
            if listen is not None and getattr(listen, "listening", False):
                listen.clear()
        except Exception:
            pass

        submit_result = ""
        try:
            # Phase 1: fill email (Plan A style selectors + events)
            filled = page.run_js(
                """
const email = arguments[0];
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
const input = Array.from(document.querySelectorAll(
  'input[data-testid="email"], input[name="email"], input[type="email"], input[autocomplete="email"]'
)).find((node) => isVisible(node) && !node.disabled && !node.readOnly)
  || Array.from(document.querySelectorAll('input')).find((n) => {
      if (!isVisible(n) || n.disabled) return false;
      const meta = [n.type, n.name, n.id, n.placeholder, n.getAttribute('data-testid')].join(' ').toLowerCase();
      return meta.includes('email') || n.type === 'email';
  }) || null;
if (!input) return 'no-input';
input.focus();
input.click();
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const tracker = input._valueTracker;
if (tracker) tracker.setValue('');
if (setter) setter.call(input, email); else input.value = email;
input.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, data:email, inputType:'insertText'}));
input.dispatchEvent(new InputEvent('input', {bubbles:true, data:email, inputType:'insertText'}));
input.dispatchEvent(new Event('change', {bubbles:true}));
if ((input.value || '').trim() !== email) return 'fill-mismatch';
input.blur();
return 'filled';
""",
                email,
            )
            self._lg(f"[*] UI email fill: {filled}")
            if filled not in ("filled",):
                # last resort: broader helper
                filled2 = self._set_input_and_submit(email, "email")
                self._lg(f"[*] UI email fallback submit: {filled2}")
                submit_result = filled2
            else:
                # Short probe: full wait only if page exposes Castle / mint activity.
                self._wait_castle_ready_before_submit(page, max_wait=3.0)
                time.sleep(0.25)
                # Phase 2: click 注册 (Plan A) — avoid matching 继续 on other widgets
                clicked = page.run_js(
                    r"""
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
const input = Array.from(document.querySelectorAll(
  'input[data-testid="email"], input[name="email"], input[type="email"], input[autocomplete="email"]'
)).find((node) => isVisible(node) && !node.disabled) || null;
if (!input || !(input.value || '').trim()) return 'no-email-value';
const buttons = Array.from(document.querySelectorAll('button[type="submit"], button')).filter((node) => {
  return isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
});
// Prefer 注册 / Sign up (Plan A), then Continue as fallback
let submitButton = buttons.find((node) => {
  const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
  const t = text.toLowerCase();
  return text === '注册' || text.includes('注册') || t === 'signup' || t.includes('signup') || t.includes('sign up');
});
if (!submitButton) {
  submitButton = buttons.find((node) => {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
    const t = text.toLowerCase();
    return text.includes('继续') || t.includes('continue') || t.includes('next') || node.type === 'submit';
  });
}
if (!submitButton) return 'no-button';
submitButton.click();
return 'submitted';
"""
                )
                submit_result = str(clicked or "")
                self._lg(f"[*] UI email for castle: {submit_result}")
        except Exception as e:
            self._lg(f"[Debug] UI email castle: {e}")
            return ""

        deadline = time.time() + max(15, int(timeout or 40))
        last_diag = ""
        retried_submit = False
        while time.time() < deadline:
            c = self.read_captured_castle()
            if c:
                self._lg(f"[*] native castle len={len(c)} head={c[:20]}")
                return c
            # CreateEmail fired with empty castle → wait & re-click once
            if not retried_submit:
                try:
                    st = page.run_js(
                        """
const nets = window.__hybrid_net || [];
let short = false;
for (const n of nets) {
  const u = String((n && n.url) || '');
  const len = Number((n && n.len) || 0);
  if (u.includes('CreateEmailValidationCode') && len > 0 && len < 200) short = true;
}
return {
  short: short,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0)
};
"""
                    )
                    if (
                        isinstance(st, dict)
                        and st.get("short")
                        and (st.get("ok") or int(st.get("status") or 0) == 200)
                    ):
                        retried_submit = True
                        # Site accepted castle-less CreateEmail (body ~33B, HTTP 200).
                        # Re-click only if page suddenly exposes SDK / long token.
                        has_sdk = False
                        try:
                            probe = page.run_js(
                                r"""
let sdk = false;
try {
  const C = window.Castle || window.castle || null;
  sdk = !!(C && (C.createRequestToken || (C.default && C.default.createRequestToken)));
} catch (e) {}
return {
  sdk: sdk,
  clen: String(window.__hybrid_castle || '').length,
  st: String(window.__hybrid_castle_status || '')
};
"""
                            )
                            if isinstance(probe, dict):
                                has_sdk = bool(probe.get("sdk")) or int(
                                    probe.get("clen") or 0
                                ) >= 800
                        except Exception:
                            has_sdk = False
                        if not has_sdk:
                            self._lg(
                                "[!] CreateEmail body short (no castle) but browser OK — "
                                "skip re-click (no page Castle SDK)"
                            )
                        else:
                            self._lg(
                                "[!] CreateEmail body too short (no castle); "
                                "kick mint + wait + re-click 注册 once"
                            )
                            try:
                                self._kick_page_castle_mint(page)
                            except Exception:
                                pass
                            time.sleep(0.8)
                            self._wait_castle_ready_before_submit(page, max_wait=4.0)
                            pre = self.read_captured_castle()
                            if pre and len(pre) >= 800:
                                self._lg(
                                    f"[*] re-submit with pre-mint castle len={len(pre)}"
                                )
                            r2 = self._click_register_button(page)
                            self._lg(f"[*] UI email re-submit: {r2}")
                            submit_result = f"{submit_result}|retry:{r2}"
                except Exception as re:
                    retried_submit = True
                    self._lg(f"[Debug] re-submit: {re}")
            # periodic diagnostics (throttled via last_diag string)
            try:
                diag = page.run_js(
                    """
return {
  net: (window.__hybrid_net||[]).length,
  nCastle: (window.__hybrid_castles||[]).length,
  clen: (window.__hybrid_castle||'').length,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  hooked: !!window.__hybrid_net_hooked,
  url: location.href.slice(0, 120)
};
"""
                )
                if isinstance(diag, dict):
                    s = (
                        f"net={diag.get('net')} castles={diag.get('nCastle')} "
                        f"clen={diag.get('clen')} seen={diag.get('seen')} "
                        f"ok={diag.get('ok')} st={diag.get('status')} "
                        f"hooked={diag.get('hooked')}"
                    )
                    if s != last_diag and (
                        diag.get("seen")
                        or diag.get("net")
                        or int(diag.get("clen") or 0) > 0
                    ):
                        self._lg(f"[*] castle wait: {s}")
                        last_diag = s
            except Exception:
                pass
            time.sleep(0.35)

        # Final diagnostic dump before fallback
        try:
            diag = page.run_js(
                """
const nets = (window.__hybrid_net||[]).slice(-8);
return {
  net: nets,
  nCastle: (window.__hybrid_castles||[]).length,
  clen: (window.__hybrid_castle||'').length,
  seen: !!window.__hybrid_create_email_seen,
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  hooked: !!window.__hybrid_net_hooked,
  submit: String(arguments[0]||'')
};
""",
                submit_result,
            )
            self._lg(f"[!] native castle timeout diag={diag}")
        except Exception as e:
            self._lg(f"[!] native castle timeout ({e})")

        # CreateEmail 可能已 200 且 body 无 castle（站点侧可不带 token）。
        # 返回空串，由 hybrid 根据 create_email_sent_via_browser() 决定是否继续。
        try:
            st = page.run_js(
                """
return {
  ok: !!window.__hybrid_create_email_ok,
  status: Number(window.__hybrid_create_email_status||0),
  seen: !!window.__hybrid_create_email_seen
};
"""
            )
            if isinstance(st, dict) and (
                st.get("ok") or int(st.get("status") or 0) == 200
            ):
                self._lg(
                    f"[!] no castle in CreateEmail body but browser status "
                    f"ok={st.get('ok')} status={st.get('status')} → continue without castle"
                )
                return ""
        except Exception:
            pass
        self._lg(
            "[!] native castle timeout; no browser CreateEmail success either → empty"
        )
        return ""

    def get_castle_token_injected(self, timeout: int = 45) -> str:
        """Legacy CDN inject path (often short / wrong format)."""
        return self._get_castle_token_injected_impl(timeout=timeout)

    def close(self):
        from grok_register_ttk import shutdown_browser

        try:
            shutdown_browser()
        except Exception:
            pass
        self._started = False

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.close()
        return False

    def open_signup(self):
        from grok_register_ttk import open_signup_page

        open_signup_page(log_callback=self.log)

    def export_cookies(self) -> dict:
        from grok_register_ttk import _get_browser

        jar = {}
        try:
            browser = _get_browser()
            cookies = browser.cookies() if browser else []
            for c in cookies or []:
                if isinstance(c, dict):
                    n, v = c.get("name", ""), c.get("value", "")
                else:
                    n, v = getattr(c, "name", ""), getattr(c, "value", "")
                if n:
                    jar[str(n)] = str(v)
        except Exception as e:
            self._lg(f"[Debug] export_cookies: {e}")
        return jar

    def scrape_next_action(self) -> str:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            action = page.run_js(
                r"""
const html = document.documentElement.innerHTML || '';
let m = html.match(/next-action["'\s:=]+([a-f0-9]{40,})/i);
if (m) return m[1];
for (const s of Array.from(document.scripts || [])) {
  const t = s.textContent || '';
  const idx = t.indexOf('createUserAndSession');
  if (idx >= 0) {
    const slice = t.slice(Math.max(0, idx - 300), idx + 400);
    const m3 = slice.match(/[a-f0-9]{40,}/);
    if (m3) return m3[0];
  }
}
return '';
"""
            )
            return str(action or "")
        except Exception:
            return ""

    def _extract_castle_pk(self) -> str:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            pk = page.run_js(
                r"""
const html = document.documentElement.innerHTML || '';
const patterns = [
  /"castlePk":"([^"]+)"/,
  /castlePk\\":\\"([^\\"]+)/,
  /castlePk["']?\s*[:=]\s*["'](pk_[^"']+)/,
];
for (const p of patterns) {
  const m = html.match(p);
  if (m && m[1]) return m[1];
}
return '';
"""
            )
            if pk and str(pk).startswith("pk_"):
                return str(pk)
        except Exception as e:
            self._lg(f"[Debug] castle pk: {e}")
        return "pk_p8GGWvD3TmFJZRsX3BQcqAv9aFVispNz"

    def _ensure_castle_sdk(self, pk: str) -> bool:
        """Inject @castleio/castle-js and start createRequestToken (no top-level await)."""
        from grok_register_ttk import _get_page

        page = _get_page()
        # already minting / done?
        try:
            st = page.run_js(
                "return {s: window.__hybrid_castle_status||'', l:(window.__hybrid_castle||'').length};"
            )
            if isinstance(st, dict) and (st.get("s") == "done" or int(st.get("l") or 0) > 40):
                return True
        except Exception:
            pass

        cdn = "https://cdn.jsdelivr.net/npm/@castleio/castle-js@2.1.8/dist/castle.min.js"
        try:
            page.run_js(
                f"""
window.__hybrid_castle = window.__hybrid_castle || '';
window.__hybrid_castle_status = 'loading-sdk';
window.__hybrid_castle_err = '';
(function(){{
  function mint(C) {{
    try {{
      var api = C;
      if (api && api.default) api = api.default;
      if (api && typeof api.configure === 'function') {{
        try {{ api.configure({{pk: {pk!r}}}); }} catch (e1) {{}}
      }}
      var fn = null;
      if (api && typeof api.createRequestToken === 'function') fn = api.createRequestToken.bind(api);
      if (!fn && typeof C === 'function') {{
        try {{
          var inst = C({{pk: {pk!r}}});
          if (inst && typeof inst.createRequestToken === 'function') fn = inst.createRequestToken.bind(inst);
        }} catch (e2) {{}}
      }}
      if (!fn) {{
        window.__hybrid_castle_status = 'no-method';
        window.__hybrid_castle_methods = api ? Object.keys(api) : [];
        return;
      }}
      window.__hybrid_castle_status = 'minting';
      Promise.resolve(fn()).then(function(t){{
        window.__hybrid_castle = String(t || '');
        window.__hybrid_castle_status = (window.__hybrid_castle.length > 20) ? 'done' : 'empty';
      }}).catch(function(e){{
        window.__hybrid_castle_err = String(e);
        window.__hybrid_castle_status = 'error';
      }});
    }} catch (e) {{
      window.__hybrid_castle_err = String(e);
      window.__hybrid_castle_status = 'exception';
    }}
  }}
  var existing = window.Castle || window.castle || window['@castleio/castle-js'] || null;
  if (existing) {{ mint(existing); return; }}
  if (window.__hybrid_castle_script) {{ return; }}
  window.__hybrid_castle_script = true;
  var s = document.createElement('script');
  s.src = {cdn!r};
  s.onload = function(){{
    var C = window.Castle || window.castle || window['@castleio/castle-js'] || null;
    mint(C);
  }};
  s.onerror = function(){{
    window.__hybrid_castle_err = 'sdk script load failed';
    window.__hybrid_castle_status = 'sdk-fail';
  }};
  document.head.appendChild(s);
}})();
true;
"""
            )
            return True
        except Exception as e:
            self._lg(f"[Debug] ensure castle sdk: {e}")
            return False

    def _get_castle_token_injected_impl(self, timeout: int = 45) -> str:
        """Mint Castle request token via injected SDK (page has no window.Castle)."""
        from grok_register_ttk import _get_page

        page = _get_page()
        pk = self._extract_castle_pk()
        self._lg(f"[*] castle pk={pk[:16]}...")
        self._ensure_castle_sdk(pk)
        deadline = time.time() + timeout
        last_status = ""
        while time.time() < deadline:
            try:
                data = page.run_js(
                    """
let castle = '';
try {
  // prefer native-captured long token if present
  if (window.__hybrid_castles && window.__hybrid_castles.length) {
    for (const t of window.__hybrid_castles) {
      if (String(t||'').length > String(castle||'').length) castle = String(t);
    }
  }
  if ((!castle || castle.length < 1000) && window.__hybrid_castle) castle = String(window.__hybrid_castle);
} catch (e) {}
const el = document.querySelector('input[name*="castle" i], textarea[name*="castle" i]');
if (!castle && el) castle = String(el.value || '').trim();
return {
  castle: castle || '',
  status: String(window.__hybrid_castle_status || ''),
  err: String(window.__hybrid_castle_err || ''),
  methods: window.__hybrid_castle_methods || []
};
"""
                )
                if isinstance(data, dict):
                    castle = str(data.get("castle") or "")
                    last_status = f"{data.get('status')}|{data.get('err')}|{data.get('methods')}"
                    # accept short injected tokens only as last resort
                    if len(castle) >= 40:
                        self._lg(f"[*] castle token len={len(castle)}")
                        return castle
                    st = str(data.get("status") or "")
                    if st in ("no-method", "sdk-fail", "error", "exception", "empty"):
                        page.run_js(
                            "window.__hybrid_castle_script=false; window.__hybrid_castle_status=''; true;"
                        )
                        self._ensure_castle_sdk(pk)
            except Exception:
                pass
            time.sleep(0.5)
        self._lg(f"[!] castle token timeout last={last_status}")
        return ""

    def get_castle_token(self, timeout: int = 45) -> str:
        """Prefer native-captured IBYIll token; fallback to injected SDK."""
        c = self.read_captured_castle()
        if c:
            self._lg(f"[*] castle from capture len={len(c)}")
            return c
        return self._get_castle_token_injected_impl(timeout=timeout)

    def _extract_turnstile_sitekey(self) -> str:
        from grok_register_ttk import _get_page

        page = _get_page()
        try:
            sk = page.run_js(
                r"""
const html = document.documentElement.innerHTML || '';
const pats = [
  /"sitekey":"(0x4[^"]+)"/,
  /sitekey\\":\\"(0x4[^\\"]+)/,
  /sitekey["']?\s*[:=]\s*["'](0x4[^"']+)/i,
];
for (const p of pats) {
  const m = html.match(p);
  if (m && m[1]) return m[1];
}
const el = document.querySelector('[data-sitekey], .cf-turnstile');
if (el) {
  const v = el.getAttribute('data-sitekey') || '';
  if (v) return v;
}
return '';
"""
            )
            if sk and str(sk).startswith("0x"):
                return str(sk)
        except Exception as e:
            self._lg(f"[Debug] sitekey: {e}")
        return "0x4AAAAAAAhr9JGVDZbrZOo0"

    def inject_turnstile_widget(self, sitekey: str = "") -> bool:
        """Mount a standalone Turnstile widget (turnstilePatch can auto-solve)."""
        from grok_register_ttk import _get_page

        page = _get_page()
        sk = (sitekey or self._extract_turnstile_sitekey()).strip()
        self._lg(f"[*] turnstile sitekey={sk[:20]}...")
        try:
            page.run_js(
                f"""
window.__hybrid_turnstile = '';
window.__hybrid_turnstile_status = 'init';
(function(){{
  var sitekey = {sk!r};
  function renderWhenReady() {{
    if (!window.turnstile || typeof turnstile.render !== 'function') {{
      window.__hybrid_turnstile_status = 'waiting-api';
      return false;
    }}
    var host = document.getElementById('hybrid-turnstile-host');
    if (!host) {{
      host = document.createElement('div');
      host.id = 'hybrid-turnstile-host';
      host.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:#111;padding:8px;';
      document.body.appendChild(host);
    }} else {{
      host.innerHTML = '';
    }}
    try {{
      turnstile.render(host, {{
        sitekey: sitekey,
        theme: 'dark',
        size: 'flexible',
        callback: function(token) {{
          window.__hybrid_turnstile = String(token || '');
          window.__hybrid_turnstile_status = 'done';
        }},
        'error-callback': function() {{
          window.__hybrid_turnstile_status = 'error';
        }},
        'expired-callback': function() {{
          window.__hybrid_turnstile_status = 'expired';
        }}
      }});
      window.__hybrid_turnstile_status = 'rendered';
      return true;
    }} catch (e) {{
      window.__hybrid_turnstile_status = 'render-fail';
      window.__hybrid_turnstile_err = String(e);
      return false;
    }}
  }}
  if (renderWhenReady()) return;
  if (!document.getElementById('hybrid-cf-script')) {{
    var s = document.createElement('script');
    s.id = 'hybrid-cf-script';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = function(){{ renderWhenReady(); }};
    s.onerror = function(){{ window.__hybrid_turnstile_status = 'script-fail'; }};
    document.head.appendChild(s);
  }}
  var n = 0;
  var t = setInterval(function(){{
    n += 1;
    if (renderWhenReady() || n > 40) clearInterval(t);
  }}, 250);
}})();
true;
"""
            )
            return True
        except Exception as e:
            self._lg(f"[Debug] inject turnstile: {e}")
            return False

    def get_turnstile_token(
        self,
        timeout: int = 90,
        inject: bool = True,
        *,
        fast: bool = False,
        auto_wait_cap: float | None = None,
    ) -> str:
        from grok_register_ttk import _get_page, getTurnstileToken

        page = _get_page()
        if inject:
            self.inject_turnstile_widget()

        # 必须把 timeout/fast 传下去（旧代码默认 50s 且无视 fast）
        try:
            tok = getTurnstileToken(
                timeout=int(timeout or 50),
                log_callback=self.log,
                fast=bool(fast),
                auto_wait_cap=auto_wait_cap,
            )
            if tok and len(str(tok)) >= 80:
                return str(tok)
        except TypeError:
            # 旧 shim 不认 fast / auto_wait_cap
            try:
                tok = getTurnstileToken(timeout=int(timeout or 50), log_callback=self.log)
                if tok and len(str(tok)) >= 80:
                    return str(tok)
            except Exception as e:
                self._lg(f"[Debug] getTurnstileToken: {e}")
        except Exception as e:
            self._lg(f"[Debug] getTurnstileToken: {e}")

        deadline = time.time() + max(5, int(timeout or 50))
        while time.time() < deadline:
            try:
                tok = page.run_js(
                    """
let tok = '';
try { if (window.__hybrid_turnstile) tok = String(window.__hybrid_turnstile); } catch (e) {}
if (!tok) {
  const byInput = String((document.querySelector('input[name="cf-turnstile-response"]') || {}).value || '').trim();
  if (byInput) tok = byInput;
}
try {
  if (!tok && window.turnstile && typeof turnstile.getResponse === 'function') {
    tok = String(turnstile.getResponse() || '').trim();
  }
} catch (e) {}
return {
  tok: tok || '',
  status: String(window.__hybrid_turnstile_status || ''),
  err: String(window.__hybrid_turnstile_err || '')
};
"""
                )
                if isinstance(tok, dict):
                    status = tok.get("status")
                    val = str(tok.get("tok") or "").strip()
                    if len(val) >= 80:
                        self._lg(f"[*] turnstile len={len(val)} status={status}")
                        return val
                    if status in ("script-fail", "render-fail", "error"):
                        self.inject_turnstile_widget()
                else:
                    val = str(tok or "").strip()
                    if len(val) >= 80:
                        self._lg(f"[*] turnstile len={len(val)}")
                        return val
            except Exception:
                pass
            time.sleep(1)
        # 外置 Solver / YesCaptcha 兜底（设置页开关或 env）
        try:
            from turnstile_solver_client import solve_turnstile, solver_enabled, yescaptcha_key

            if solver_enabled() or yescaptcha_key():
                self._lg("[*] turnstile page miss → external solver…")
                sk = ""
                try:
                    sk = self._extract_turnstile_sitekey() or ""
                except Exception:
                    sk = ""
                ext = solve_turnstile(
                    siteurl="https://accounts.x.ai/sign-up",
                    sitekey=sk,
                    max_wait=min(90, max(30, int(timeout or 50))),
                    log=self._lg,
                )
                if ext and len(str(ext)) >= 80:
                    self._lg(f"[*] turnstile external len={len(ext)}")
                    return str(ext)
        except Exception as ee:
            self._lg(f"[Debug] external turnstile: {ee}")
        self._lg("[!] turnstile timeout")
        return ""

    def _set_input_and_submit(self, value: str, kind: str) -> str:
        """Fill visible email/code input and click continue. kind=email|code"""
        from grok_register_ttk import _get_page

        page = _get_page()
        return str(
            page.run_js(
                """
const value = String(arguments[0] || '');
const kind = String(arguments[1] || 'email');
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function setInputValue(input, v) {
  input.focus(); input.click();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const tracker = input._valueTracker;
  if (tracker) tracker.setValue('');
  if (setter) setter.call(input, v); else input.value = v;
  input.dispatchEvent(new Event('focus', {bubbles:true}));
  input.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, data:v, inputType:'insertText'}));
  input.dispatchEvent(new InputEvent('input', {bubbles:true, data:v, inputType:'insertText'}));
  input.dispatchEvent(new Event('change', {bubbles:true}));
  input.dispatchEvent(new Event('blur', {bubbles:true}));
}
let input = null;
if (kind === 'email') {
  input = Array.from(document.querySelectorAll('input, textarea')).find((node) => {
    if (!isVisible(node) || node.disabled) return false;
    const type = String(node.getAttribute('type') || '').toLowerCase();
    if (['password','hidden','checkbox','radio','submit','button'].includes(type)) return false;
    const meta = [node.getAttribute('data-testid'), node.name, node.id, node.placeholder, type].join(' ').toLowerCase();
    return meta.includes('email') || meta.includes('mail') || type === 'email';
  }) || null;
} else {
  input = Array.from(document.querySelectorAll(
    'input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[inputmode="text"]'
  )).find((node) => isVisible(node) && !node.disabled && Number(node.maxLength || 6) > 1) || null;
  if (!input) {
    const boxes = Array.from(document.querySelectorAll('input')).filter((node) => {
      if (!isVisible(node) || node.disabled) return false;
      return Number(node.maxLength || 0) === 1;
    });
    if (boxes.length >= value.length) {
      for (let i = 0; i < value.length; i++) {
        setInputValue(boxes[i], value[i] || '');
      }
      input = boxes[0];
    }
  }
}
if (!input && kind === 'email') return 'no-email-input';
if (!input && kind === 'code') return 'no-code-input';
if (kind === 'email' || Number(input.maxLength || 6) > 1) setInputValue(input, value);
const buttons = Array.from(document.querySelectorAll('button[type="submit"], button, [role="button"]'))
  .filter((node) => isVisible(node) && !node.disabled);
const submit = buttons.find((node) => {
  const t = (node.innerText || node.textContent || '').replace(/\\s+/g, '').toLowerCase();
  return t.includes('注册') || t.includes('继续') || t.includes('下一步') || t.includes('完成')
    || t.includes('continue') || t.includes('next') || t.includes('confirm') || t.includes('sign');
}) || buttons.find((n) => String(n.getAttribute('type')||'').toLowerCase()==='submit') || buttons[0];
if (submit) { submit.click(); return 'submitted'; }
return 'filled-no-button';
                """,
                value,
                kind,
            )
            or ""
        )

    def prepare_profile_step_for_turnstile(
        self, email: str, code: str, timeout: int = 90
    ) -> bool:
        """Drive UI email->code->profile so Turnstile widget mounts.

        Protocol already verified the code; UI path still needed for widget.
        Prefer staying on current tab; only reopen signup if page is dead.
        """
        from grok_register_ttk import _get_page

        clean = str(code or "").replace("-", "").strip()
        page = _get_page()
        need_reopen = page is None
        if not need_reopen:
            try:
                page.run_js("return 1")
            except Exception:
                need_reopen = True
        if need_reopen:
            try:
                from grok_register_ttk import refresh_active_page

                if callable(refresh_active_page):
                    refresh_active_page()
            except Exception:
                pass
            try:
                self.open_signup()
            except Exception as e:
                self._lg(f"[Debug] reopen signup: {e}")
            page = _get_page()

        deadline = time.time() + timeout
        email_done = code_done = False
        while time.time() < deadline:
            try:
                page = _get_page() or page
                if page is None:
                    time.sleep(0.5)
                    continue
                state = page.run_js(
                    r"""
function isVisible(node) {
  if (!node) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
const pw = Array.from(document.querySelectorAll('input[type="password"], input[name="password"]')).some(isVisible);
const cf = !!document.querySelector('input[name="cf-turnstile-response"], div.cf-turnstile, iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]');
const email = Array.from(document.querySelectorAll('input[type="email"], input[name="email"], input[data-testid="email"]')).some(isVisible);
const code = Array.from(document.querySelectorAll('input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]')).some(isVisible)
  || Array.from(document.querySelectorAll('input')).filter(n => isVisible(n) && Number(n.maxLength||0)===1).length >= 4;
const given = Array.from(document.querySelectorAll('input[name="givenName"], input[name="familyName"], input[autocomplete="given-name"]')).some(isVisible);
return {pw:!!pw, cf:!!cf, email:!!email, code:!!code, given:!!given, url: location.href};
"""
                )
            except Exception as e:
                self._lg(f"[Debug] profile state: {e}")
                time.sleep(0.6)
                continue

            if isinstance(state, dict) and (
                state.get("pw") or state.get("cf") or state.get("given")
            ):
                self._lg(f"[*] profile/turnstile ready state={state}")
                return True

            if isinstance(state, dict) and state.get("email") and not email_done:
                r = self._set_input_and_submit(email, "email")
                self._lg(f"[*] UI email submit: {r}")
                email_done = True
                time.sleep(1.5)
                continue

            if isinstance(state, dict) and state.get("code") and not code_done:
                r = self._set_input_and_submit(clean, "code")
                self._lg(f"[*] UI code submit: {r}")
                code_done = True
                time.sleep(2.0)
                continue

            if (
                isinstance(state, dict)
                and not code_done
                and clean
                and not state.get("pw")
                and not state.get("given")
            ):
                try:
                    r = self._set_input_and_submit(clean, "code")
                    self._lg(f"[*] UI code force submit: {r}")
                    if r and "no-code" not in str(r):
                        code_done = True
                        time.sleep(2.0)
                        continue
                except Exception:
                    pass

            if isinstance(state, dict) and not state.get("email") and not state.get("code"):
                try:
                    from grok_register_ttk import click_email_signup_button

                    click_email_signup_button(timeout=5, log_callback=self.log)
                except Exception:
                    pass
            time.sleep(0.8)
        self._lg("[!] profile step timeout")
        return False



def harvest_tokens(
    *,
    stay_on_profile: bool = True,
    timeout: int = 90,
    log: Optional[Callable[[str], None]] = None,
) -> HarvestedTokens:
    """Backward-compatible one-shot harvest."""
    out = HarvestedTokens()
    with BrowserTokenSession(log=log) as sess:
        sess.open_signup()
        out.castle = sess.get_castle_token(timeout=min(45, timeout))
        out.turnstile = sess.get_turnstile_token(timeout=min(30, timeout)) if stay_on_profile else ""
        out.cookies = sess.export_cookies()
        out.next_action = sess.scrape_next_action()
        out.page_url = "https://accounts.x.ai/sign-up"
    return out


if __name__ == "__main__":
    t = harvest_tokens(log=print, timeout=60)
    print("turnstile_len", len(t.turnstile))
    print("castle_len", len(t.castle))
    print("cookies", list((t.cookies or {}).keys())[:10])
    print("next_action", t.next_action[:40] if t.next_action else "")
