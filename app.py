# app.py — AMC Spark & Services
# Brevo API emails + JSON logging + Admin dashboard (auth + status/remarks/email + overdue alerts)

from __future__ import annotations

import os, re, hashlib, hmac, html, json, uuid, threading, time, fcntl, base64
from datetime import datetime, timezone, timedelta
from io import BytesIO
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from urllib.parse import urlencode

from PIL import Image, ImageDraw, ImageFont

from flask import (
    Flask, request, jsonify, send_from_directory, redirect,
    url_for, session
)
from werkzeug.utils import secure_filename
from werkzeug.exceptions import NotFound
from typing import overload

# ---------------- .env loader (optional) ----------------
DOTENV: dict[str, str | None] = {}
try:
    from dotenv import dotenv_values
    DOTENV = dotenv_values(os.path.join(os.getcwd(), ".env")) or {}
except Exception:
    DOTENV = {}

@overload
def env(key: str, default: str) -> str: ...
@overload
def env(key: str, default: None = None) -> str | None: ...
def env(key: str, default: str | None = None) -> str | None:
    val = DOTENV.get(key)
    return val if val is not None else os.getenv(key, default)

# ---------------- Config ----------------
# Anchor relative paths to this file's own directory, not the process's current
# working directory. Without this, running the app from any other cwd (a
# different launch script, working directory, etc.) makes every relative path
# below resolve to the wrong place: static assets/images 403, uploads saved to
# the wrong folder, submission logs written somewhere unexpected.
BASE_DIR        = os.path.dirname(os.path.abspath(__file__))

PORT            = int(env("PORT", "5000"))
STATIC_DIR      = os.path.join(BASE_DIR, env("STATIC_DIR", "static"))
UPLOAD_DIR      = os.path.join(BASE_DIR, env("UPLOAD_DIR", "uploads") or "uploads")

# Email is sent via Brevo's HTTPS transactional API, not raw SMTP. GoDaddy's
# SMTP (smtpout.secureserver.net) turned out to silently blackhole connections
# from Render's network on both port 465 and 587 - confirmed via the actual
# traceback, which failed at the raw TCP connect() stage, before TLS or auth
# ever started. Plain HTTPS to a provider built for this (Brevo) sidesteps
# that whole class of "some host blocks some SMTP port" problem.
BREVO_API_KEY   = env("BREVO_API_KEY", "")
BREVO_API_URL   = "https://api.brevo.com/v3/smtp/email"
EMAIL_USER      = env("EMAIL_USER")
SMTP_FROM       = env("SMTP_FROM", EMAIL_USER or "no-reply@localhost")  # "Name <email>" - used as the Brevo sender
ADMIN_EMAIL     = env("ADMIN_EMAIL", EMAIL_USER or "")
HR_EMAIL        = env("HR_EMAIL", "")
# How long to wait for Brevo's API to respond before giving up. Kept
# comfortably below the gunicorn --timeout so a real failure returns a clean
# JSON error to the client instead of gunicorn killing the whole worker.
EMAIL_SEND_TIMEOUT = int(env("EMAIL_SEND_TIMEOUT", "20"))

MAX_EMAIL_MB    = int(env("MAX_EMAIL_MB", "19"))
MAX_EMAIL_BYTES = MAX_EMAIL_MB * 1024 * 1024

ALLOWED_EXTS    = {".pdf",".doc",".docx",".xls",".xlsx",".csv",".zip",".png",".jpg",".jpeg",".txt"}

# Admin auth + logs/state
SECRET_KEY      = env("SECRET_KEY", "please_change_me")
ADMIN_USER_ID   = env("ADMIN_USER", "admin")
ADMIN_PASS      = env("ADMIN_PASS", "password")
SUBMIT_LOG      = os.path.join(BASE_DIR, env("SUBMIT_LOG", "submissions.jsonl"))     # supports .jsonl and .json
SUBMIT_STATE    = os.path.join(BASE_DIR, env("SUBMIT_STATE", "ticket_state.json"))   # stores status/remarks/history
ALERT_EMAIL     = env("ALERT_EMAIL", "info@amcspark.com")    # overdue alerts recipient

# Invoice number sequence lives here (server-side, shared across every device/
# person using the invoice generator) instead of each browser's own
# localStorage, which let two different devices independently hand out the
# same invoice number.
INVOICE_SEQ_STATE = os.path.join(BASE_DIR, env("INVOICE_SEQ_STATE", "invoice_seq.json"))
INVOICE_PREFIX     = env("INVOICE_PREFIX", "ASAS")

HEALTH_CHECK_EMAIL = env("HEALTH_CHECK_EMAIL", "akshitbatrax@gmail.com")
HEALTH_CHECK_STATE = os.path.join(BASE_DIR, env("HEALTH_CHECK_STATE", "health_check_state.json"))

# GitHub Actions dispatch - lets the admin "Login Healthcheck (Video)" button
# kick off qa/admin_login_test.js on a GitHub-hosted runner, since this
# server has no browser to record screenshots/video itself (see the
# login-healthcheck workflow file for what actually runs).
GITHUB_REPO           = env("GITHUB_REPO", "akshitbatrax/AMC_Website")
GITHUB_WORKFLOW_FILE  = env("GITHUB_WORKFLOW_FILE", "login-healthcheck.yml")
GITHUB_DISPATCH_REF   = env("GITHUB_DISPATCH_REF", "uat")
GITHUB_DISPATCH_TOKEN = env("GITHUB_DISPATCH_TOKEN", "")

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["SECRET_KEY"] = SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = (MAX_EMAIL_MB + 5) * 1024 * 1024
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = (env("SESSION_COOKIE_SECURE", "0") or "0") == "1"

# ---------------- Branding ----------------
BRAND = {
    "name": "AMC Spark & Services",
    "brand": "#0ea5ff",
    "brand2": "#22c55e",
    "ink": "#0f172a",
    "muted": "#475569",
    "bg": "#f6f8fb",
    "line": "#e5e7eb",
    "ok": "#1b6e4a",
    "danger": "#b3261e",
    "site": "https://www.amcspark.com/",
    "email": "info@amcspark.com",
    "phone": "+91 9220533011",
    "addr": "C-7, GF, RPS Palms, Sector 88, Faridabad, Haryana 121002"
}

# ---------------- Helpers ----------------
def _mask_user(u):
    if not u: return ""
    try:
        local, domain = u.split("@", 1)
        masked = (local[0] + "*"*(len(local)-2) + local[-1]) if len(local) > 2 else "*"*len(local)
        return f"{masked}@{domain}"
    except Exception:
        return u

def _valid_email(v: str) -> bool:
    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", v or ""))

def _recipients():
    rec = []
    for chunk in (ADMIN_EMAIL, HR_EMAIL):
        if chunk:
            rec += [x.strip() for x in chunk.split(",") if x.strip()]
    if not rec and EMAIL_USER:
        rec = [EMAIL_USER]
    out, seen = [], set()
    for r in rec:
        rl = r.lower()
        if rl not in seen:
            seen.add(rl); out.append(r)
    return out

def _attach_safe(filename: str) -> str:
    base = secure_filename(filename or "file")
    return re.sub(r"[^A-Za-z0-9_.-]", "_", base)[:180] or "file"

def _ext_allowed(name: str) -> bool:
    _, ext = os.path.splitext(name or "")
    return ext.lower() in ALLOWED_EXTS

def _plain_from_html(html: str) -> str:
    text = re.sub(r"(?is)<style.*?>.*?</style>", "", html or "")
    text = re.sub(r"(?is)<script.*?>.*?</script>", "", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    return text.strip()

def _ticket(prefix: str, seed: str) -> str:
    h = hashlib.sha1((prefix + "|" + seed + "|" + datetime.utcnow().isoformat()).encode()).hexdigest()
    return (prefix + "-" + h[:8]).upper()

def _parse_ts(ts: str) -> datetime:
    if not ts:
        return datetime.utcnow().replace(tzinfo=timezone.utc)
    try:
        if ts.endswith("Z"):
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        dt = datetime.fromisoformat(ts)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.utcnow().replace(tzinfo=timezone.utc)

def _age_hours(ts: str) -> float:
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    dt = _parse_ts(ts)
    return max(0.0, (now - dt).total_seconds() / 3600.0)

# ---------------- Email templates ----------------
def email_shell_html(preheader: str, inner_html: str) -> str:
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:{BRAND['bg']};">
  <span style="display:none!important;opacity:0;visibility:hidden">{preheader}</span>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:{BRAND['bg']};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" style="max-width:600px;background:#fff;border:1px solid {BRAND['line']};border-radius:14px;overflow:hidden">
        <tr><td style="padding:18px 22px;border-bottom:1px solid {BRAND['line']};background:linear-gradient(90deg,{BRAND['brand']},{BRAND['brand2']});color:#00121b;font:800 18px Arial">
          ⚡ {BRAND['name']} <span style="float:right;font:700 12px Arial"><a href="{BRAND['site']}" style="color:#00121b;text-decoration:none">Visit Website →</a></span>
        </td></tr>
        <tr><td style="padding:22px">{inner_html}</td></tr>
        <tr><td style="padding:14px 22px;border-top:1px solid {BRAND['line']};background:#f9fbff;font:12px Arial;color:{BRAND['muted']}">
          📍 {BRAND['addr']} • 📞 {BRAND['phone']} • ✉️ {BRAND['email']}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""

def _row(k, v):
    return f"""<tr>
<td style="padding:8px 10px;border-bottom:1px solid {BRAND['line']};font:700 13px Arial;color:{BRAND['muted']};width:35%">{k}</td>
<td style="padding:8px 10px;border-bottom:1px solid {BRAND['line']};font:400 13px Arial;color:{BRAND['ink']};">{v}</td>
</tr>"""

def admin_email_html(title: str, fields: dict, attachments: list, ticket: str) -> str:
    rows = "".join([_row(k, fields.get(k,"")) for k in fields])
    if attachments:
        rows += "".join([_row("File", a) for a in attachments])
    inner = f"""
<p style="margin:0 0 6px;font:400 13px Arial;color:{BRAND['muted']}">New submission received. Ticket: <b>{ticket}</b></p>
<h2 style="margin:0 0 8px;font:700 18px Arial;color:{BRAND['ink']}">🔎 {title}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid {BRAND['line']};border-radius:10px;overflow:hidden">{rows}</table>
"""
    return email_shell_html(f"New {title} — Ticket {ticket}", inner)

def client_ack_html(kind: str, name: str, ticket: str) -> str:
    desc = {
        "Contact": "Thanks for your message. We’ll get back within 24 hours (Mon–Fri).",
        "Quick Quote": "We’ve logged your request. Expect a quote or clarifications in 24 hours.",
        "Project Desk": "We’ve received your scope and files. Our engineers will review and respond soon."
    }.get(kind, "We’ve received your submission.")
    inner = f"""
<h1 style="margin:0 0 8px;font:800 22px Arial;color:{BRAND['ink']}">✅ Received — {kind}</h1>
<p style="margin:0 10px 12px 0;font:400 14px Arial;color:{BRAND['muted']}">
  Hi <b>{name or 'there'}</b>, {desc}
</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px dashed {BRAND['line']};border-radius:10px">
  {_row("Ticket ID", ticket)}
  {_row("Support Window", "Mon–Fri, 9:00–18:00 IST")}
  {_row("Hotline", BRAND["phone"])}
  {_row("Email", BRAND["email"])}
</table>
"""
    return email_shell_html(f"{kind} received — Ticket {ticket}", inner)

# ---------------- Email (Brevo HTTPS API) ----------------
def smtp_ready() -> bool:
    return bool(BREVO_API_KEY and EMAIL_USER)

_FROM_HEADER_RE = re.compile(r'^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$')

def _sender_name_and_email():
    m = _FROM_HEADER_RE.match(SMTP_FROM or "")
    if m:
        name = m.group(1).strip() or BRAND["name"]
        return name, m.group(2).strip()
    return BRAND["name"], (SMTP_FROM or EMAIL_USER or "no-reply@localhost")

def send_email(subject: str, html_body: str, *, to, reply_to=None, cc=None, bcc=None, inline_images=None):
    if not BREVO_API_KEY: raise RuntimeError("BREVO_API_KEY not set")
    if not EMAIL_USER:    raise RuntimeError("EMAIL_USER not set")

    def norm_list(x):
        if not x: return []
        if isinstance(x, list): return [i.strip() for i in x if i and i.strip()]
        if isinstance(x, str):  return [i.strip() for i in x.split(",") if i.strip()]
        return []

    to_list  = norm_list(to)
    cc_list  = norm_list(cc)
    bcc_list = norm_list(bcc)
    if not to_list:
        raise RuntimeError("send_email: no recipients")

    sender_name, sender_email = _sender_name_and_email()
    payload = {
        "sender": {"name": sender_name, "email": sender_email},
        "to": [{"email": addr} for addr in to_list],
        "subject": subject,
        "htmlContent": html_body,
        "textContent": _plain_from_html(html_body),
    }
    if cc_list:  payload["cc"]  = [{"email": a} for a in cc_list]
    if bcc_list: payload["bcc"] = [{"email": a} for a in bcc_list]
    if reply_to: payload["replyTo"] = {"email": reply_to}
    if inline_images:
        # Reference each one in html_body as <img src="cid:{name}">. A base64
        # data: URI looked simpler but Gmail (and several other webmail
        # clients) silently strips inline base64 images from HTML emails as a
        # security measure - real CID-referenced attachments are what actually
        # renders inline across clients.
        payload["attachment"] = [{"name": name, "content": base64.b64encode(data).decode("ascii")}
                                  for name, data in inline_images]

    req = Request(
        BREVO_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "api-key": BREVO_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=EMAIL_SEND_TIMEOUT) as resp:
            resp.read()  # drain; Brevo returns 201 with a messageId on success
    except HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Brevo API error {e.code}: {detail}") from e
    except URLError as e:
        raise RuntimeError(f"Brevo API unreachable: {e.reason}") from e

def notify_admin_and_client(kind: str, admin_fields: dict, *,
                            client_name: str, client_email: str,
                            attachments_saved: list | None = None,
                            reply_to: str | None = None,
                            meta: dict | None = None):
    ticket = _ticket(kind[:2], client_email or admin_fields.get("Email","") or "anon")
    admin_html  = admin_email_html(kind, admin_fields, attachments_saved or [], ticket)
    client_html = client_ack_html(kind, client_name, ticket)
    # send admin
    send_email(f"{kind} — Ticket {ticket}", admin_html, to=_recipients(), reply_to=reply_to)
    # send client ack
    if _valid_email(client_email):
        send_email(f"{kind} received — {ticket}", client_html, to=[client_email], reply_to=BRAND["email"])
    # log to JSONL
    _log_submission({
        "ticket": ticket,
        "kind": kind,
        "fields": admin_fields,
        "attachments": attachments_saved or [],
        "client_name": client_name,
        "client_email": client_email,
        "meta": meta or {},
        "ts": datetime.utcnow().isoformat() + "Z"
    })
    # ensure state has an entry
    _ensure_ticket_state(ticket)

# ---------------- JSON logging & state ----------------
def _log_submission(obj: dict):
    try:
        with open(SUBMIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except Exception as e:
        app.logger.error("Failed to log submission: %s", e)

def _read_jsonl(path):
    items = []
    if not os.path.exists(path): return items
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                items.append(json.loads(line))
            except Exception:
                continue
    return items

def _read_json(path):
    if not os.path.exists(path): return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "items" in data and isinstance(data["items"], list):
            return data["items"]
        if isinstance(data, list):
            return data
    except Exception as e:
        app.logger.error("Failed to read JSON: %s", e)
    return []

def _read_submissions():
    items = []
    if SUBMIT_LOG.endswith(".json"):
        items += _read_json(SUBMIT_LOG)
        alt = SUBMIT_LOG.replace(".json", ".jsonl")
        if os.path.exists(alt): items += _read_jsonl(alt)
    else:
        items += _read_jsonl(SUBMIT_LOG)
        alt = SUBMIT_LOG.replace(".jsonl", ".json")
        if os.path.exists(alt): items += _read_json(alt)

    # de-dup by ticket (newest ts wins)
    dedup = {}
    for it in items:
        key = it.get("ticket") or ""
        ts = it.get("ts","")
        if key not in dedup or ts > dedup[key].get("ts",""): dedup[key] = it
    out = list(dedup.values())
    out.sort(key=lambda x: x.get("ts",""), reverse=True)
    return out

def _load_state():
    if not os.path.exists(SUBMIT_STATE): return {}
    try:
        with open(SUBMIT_STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_state(state: dict):
    tmp = SUBMIT_STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SUBMIT_STATE)

def _ensure_ticket_state(ticket: str):
    state = _load_state()
    if ticket not in state:
        state[ticket] = {"status": "open", "note": "", "history": []}
        _save_state(state)

def _merge_ticket(item: dict) -> dict:
    state = _load_state()
    st = state.get(item.get("ticket",""), {"status":"open","note":"","history":[]})
    merged = dict(item)
    merged["status"] = st.get("status","open")
    merged["note"] = st.get("note","")
    merged["history"] = st.get("history",[])
    return merged

def _maybe_send_overdue_alert(items: list[dict]) -> int:
    """Send a one-time email alert for tickets older than 20h (non-resolved)."""
    count = 0
    state = _load_state()
    now_iso = datetime.utcnow().isoformat() + "Z"

    for it in items:
        ticket = it.get("ticket")
        status = (it.get("status") or "open").lower()
        if not ticket:
            continue

        overdue = bool(it.get("overdue"))
        if not overdue:
            continue

        st = state.setdefault(ticket, {"status": status, "note": "", "history": []})
        if st.get("overdue_alerted"):
            continue  # already alerted once

        try:
            fields = it.get("fields", {}) or {}
            client_email = it.get("client_email") or fields.get("Email", "")
            name = fields.get("Name") or fields.get("Organisation / Dept", "") or "(no name)"
            age_h = f"{it.get('age_hours', _age_hours(it.get('ts',''))):.1f}"

            inner = f"""
<h2 style="margin:0 0 8px;font:700 18px Arial;color:{BRAND['ink']}">⚠️ Overdue Ticket &gt; 20h — {ticket}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid {BRAND['line']};border-radius:10px">
  {_row("Ticket", ticket)}
  {_row("Status", status.upper())}
  {_row("Age (hours)", age_h)}
  {_row("Submitted (UTC)", it.get("ts",""))}
  {_row("Kind", it.get("kind",""))}
  {_row("Name", name)}
  {_row("Client Email", client_email or "(n/a)")}
</table>
<p style="font:13px Arial;color:{BRAND['muted']}">This alert is sent once per ticket. Update status/remarks from Admin → Table/Drawer.</p>
"""
            subject = f"[ALERT] Ticket overdue (>20h): {ticket}"
            try:
                send_email(subject, email_shell_html("Overdue ticket", inner), to=[ALERT_EMAIL], reply_to=BRAND["email"])
            except Exception as e:
                app.logger.exception("overdue alert email failed: %s", e)
            st["overdue_alerted"] = True
            st["overdue_alerted_ts"] = now_iso
            count += 1
        finally:
            _save_state(state)
    return count

# ---------------- API: health & smtp_ready ----------------
@app.get("/api/health")
def api_health():
    return jsonify({
        "ok": True,
        "time": datetime.utcnow().isoformat() + "Z",
        "mailer": "brevo_api",
        "email_ready": smtp_ready(),
        "smtp_user": _mask_user(EMAIL_USER),
        "static_dir": STATIC_DIR,
        "upload_dir": UPLOAD_DIR,
        "max_email_mb": MAX_EMAIL_MB,
        "log_file": SUBMIT_LOG
    })

@app.get("/admin/api/smtp_ready")
def api_smtp_ready():
    return jsonify({"ok": True, "ready": smtp_ready()})

# ---------------- API: forms ----------------
@app.post("/api/contact")
def api_contact():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    message = (data.get("message") or "").strip()
    if not name or not _valid_email(email) or not message:
        return jsonify({"ok": False, "error": "Missing/invalid fields"}), 400
    fields = {"Name": name, "Email": email, "Message": message.replace("\n","<br>")}
    meta = {"ip": request.remote_addr, "ua": request.headers.get("User-Agent","")}
    try:
        notify_admin_and_client("Contact", fields, client_name=name, client_email=email, reply_to=email, meta=meta)
        return jsonify({"ok": True})
    except Exception as e:
        app.logger.exception("contact send failed")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.post("/api/quote")
def api_quote():
    data = request.get_json(silent=True) or {}
    required = ("name", "email", "phone", "ptype")
    for k in required:
        if not str(data.get(k) or "").strip():
            return jsonify({"ok": False, "error": f"Missing {k}"}), 400
    if not _valid_email(str(data.get("email") or "")):
        return jsonify({"ok": False, "error": "Invalid email"}), 400

    fields = {
        "Name": data.get("name",""),
        "Email": data.get("email",""),
        "Phone": data.get("phone",""),
        "Type": data.get("ptype",""),
        "Voltage": data.get("voltage",""),
        "When": data.get("when",""),
        "Notes": (data.get("notes") or "").replace("\n","<br>")
    }
    meta = {"ip": request.remote_addr, "ua": request.headers.get("User-Agent","")}
    try:
        notify_admin_and_client("Quick Quote", fields,
                                client_name=data.get("name",""),
                                client_email=data.get("email",""),
                                reply_to=data.get("email"),
                                meta=meta)
        return jsonify({"ok": True})
    except Exception as e:
        app.logger.exception("quote send failed")
        return jsonify({"ok": False, "error": str(e)}), 500

@app.post("/api/project")
def api_project():
    fx = lambda k: (request.form.get(k) or "").strip()
    fields = {
        "Organisation / Dept": fx("org"),
        "Name": fx("name"),
        "Email": fx("email"),
        "Phone": fx("phone"),
        "Site Location": fx("location"),
        "Project Type": fx("ptype"),
        "Procurement Mode": fx("mode"),
        "Voltage": fx("voltage"),
        "Expected PO / Start": fx("podate"),
        "Notes": fx("notes").replace("\n","<br>"),
        "Site Visit": "Yes" if (request.form.get("visit") in ("on","true","1")) else "No"
    }
    client_name  = fields["Name"]
    client_email = fields["Email"]
    if not client_name or not _valid_email(client_email):
        return jsonify({"ok": False, "error": "Missing/invalid name/email"}), 400

    attachments_saved, total = [], 0
    for f in request.files.getlist("files"):
        if not f or not f.filename:
            continue
        safe_name = _attach_safe(f.filename)
        if not _ext_allowed(safe_name):
            continue
        blob = f.read()
        if not blob:
            continue
        if total + len(blob) > MAX_EMAIL_BYTES:
            continue
        safe_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
        path = os.path.join(UPLOAD_DIR, safe_name)
        with open(path, "wb") as wf:
            wf.write(blob)
        attachments_saved.append(safe_name)
        total += len(blob)

    meta = {"ip": request.remote_addr, "ua": request.headers.get("User-Agent","")}
    try:
        notify_admin_and_client("Project Desk", fields,
                                client_name=client_name, client_email=client_email,
                                attachments_saved=attachments_saved,
                                reply_to=client_email, meta=meta)
        return jsonify({"ok": True})
    except Exception as e:
        app.logger.exception("project send failed")
        return jsonify({"ok": False, "error": str(e)}), 500

# ---------------- Admin auth helpers ----------------
def _is_authed():
    return session.get("authed") is True and session.get("who") == ADMIN_USER_ID

def _require_authed_api():
    if _is_authed():
        return None
    return jsonify({"ok": False, "error": "Unauthorized"}), 401

# ---------------- Admin: login/logout/dashboard (STATIC files) ----------------
@app.get("/admin/login")
def admin_login_page():
    return send_from_directory(STATIC_DIR, "admin-login.html")

@app.post("/admin/login")
def admin_login_post():
    user = (request.form.get("user") or "").strip()
    pwd  = (request.form.get("pass") or "").strip()
    if hmac.compare_digest(user, str(ADMIN_USER_ID)) and hmac.compare_digest(pwd, str(ADMIN_PASS)):
        session["authed"] = True
        session["who"] = ADMIN_USER_ID
        session.pop("access_logged", None)  # every fresh login re-asks for photo+name, even if a prior session had it
        return redirect(url_for("admin_verify_page", next="/admin"))
    return redirect(url_for("admin_login_page", error="1"))

@app.get("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login_page"))

def _safe_next(next_path: str | None) -> str:
    # Only ever redirect to one of our own admin pages - never an arbitrary
    # external URL from a query param.
    if next_path in ("/admin", "/invoice-generator.html"):
        return next_path
    return "/admin"

@app.get("/admin/verify")
def admin_verify_page():
    if not _is_authed():
        return redirect(url_for("admin_login_page"))
    next_path = _safe_next(request.args.get("next"))
    if session.get("access_logged") is True:
        return redirect(next_path)
    return send_from_directory(STATIC_DIR, "admin-verify.html")

@app.post("/admin/api/access-log")
def admin_api_access_log():
    guard = _require_authed_api()
    if guard: return guard

    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    photo_data_url = body.get("photo") or ""
    m = re.match(r"^data:image/(png|jpeg);base64,(.+)$", photo_data_url, re.DOTALL)
    if not name or not m:
        return jsonify({"ok": False, "error": "A name and a captured photo are both required."}), 400

    ext = "png" if m.group(1) == "png" else "jpg"
    try:
        photo_bytes = base64.b64decode(m.group(2))
    except Exception:
        return jsonify({"ok": False, "error": "Could not decode photo."}), 400
    if len(photo_bytes) > 8 * 1024 * 1024:
        return jsonify({"ok": False, "error": "Photo too large."}), 400

    # Optional close-up eye/iris crops captured alongside the main photo -
    # supplementary imagery only (a regular camera can't do real biometric
    # iris recognition, which needs an IR-illuminated sensor), so these are
    # just extra visual detail, not a biometric match.
    iris_urls = body.get("iris") or []
    inline_images = [(f"access-photo.{ext}", photo_bytes)]
    iris_html = ""
    if isinstance(iris_urls, list):
        for i, url in enumerate(iris_urls[:2]):
            im = re.match(r"^data:image/(png|jpeg);base64,(.+)$", url or "", re.DOTALL)
            if not im:
                continue
            try:
                iris_bytes = base64.b64decode(im.group(2))
            except Exception:
                continue
            if len(iris_bytes) > 2 * 1024 * 1024:
                continue
            iris_ext = "png" if im.group(1) == "png" else "jpg"
            cid = f"access-iris-{i}.{iris_ext}"
            inline_images.append((cid, iris_bytes))
            iris_html += f'<img src="cid:{cid}" alt="Eye close-up" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid {BRAND["line"]};margin-right:8px">'

    stamp = _now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
    safe_name = html.escape(name)[:200]
    inner = f"""
<h2 style="margin:0 0 8px;font:700 18px Arial;color:{BRAND['ink']}">🔐 Office Use Only — Access Log</h2>
<p style="margin:0 0 12px;font:400 14px Arial;color:{BRAND['muted']}">Someone logged into the admin/office area and completed the access-verification step (live face + blink check).</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid {BRAND['line']};border-radius:10px">
  <tr><td style="padding:10px 12px;font:700 13px Arial;width:110px;color:{BRAND['muted']}">Name</td><td style="padding:10px 12px;font:700 14px Arial;color:{BRAND['ink']}">{safe_name}</td></tr>
  <tr><td style="padding:10px 12px;font:700 13px Arial;color:{BRAND['muted']}">Time</td><td style="padding:10px 12px;font:400 13px Arial;color:{BRAND['ink']}">{stamp}</td></tr>
  <tr><td style="padding:10px 12px;font:700 13px Arial;color:{BRAND['muted']}">IP</td><td style="padding:10px 12px;font:400 13px Arial;color:{BRAND['ink']}">{html.escape(request.headers.get('X-Forwarded-For', request.remote_addr) or '')}</td></tr>
</table>
<p style="margin:14px 0 0"><img src="cid:access-photo.{ext}" alt="Access photo" style="max-width:100%;border-radius:10px;border:1px solid {BRAND['line']}"></p>
{f'<p style="margin:12px 0 0">{iris_html}</p>' if iris_html else ""}
"""
    try:
        send_email(
            f"Office Use Only — Access Log: {name}",
            email_shell_html(f"Access log: {name}", inner),
            to=[HEALTH_CHECK_EMAIL],
            inline_images=inline_images,
        )
    except Exception:
        app.logger.exception("access-log email failed")
        return jsonify({"ok": False, "error": "Could not send the access log email - please try again."}), 502

    session["access_logged"] = True
    return jsonify({"ok": True})

@app.get("/admin")
def admin_dashboard_page():
    if not _is_authed():
        return redirect(url_for("admin_login_page"))
    if not session.get("access_logged"):
        return redirect(url_for("admin_verify_page", next="/admin"))
    return send_from_directory(STATIC_DIR, "admin.html")

# The invoice generator used to be gated only by a password hardcoded in its
# own JS (readable by anyone via view-source, and the page content was
# downloaded regardless of whether it was "unlocked"). Gate it server-side
# with the same admin session instead - a real access control, not a UI trick.
@app.get("/invoice-generator.html")
def invoice_generator_page():
    if not _is_authed():
        return redirect(url_for("admin_login_page"))
    if not session.get("access_logged"):
        return redirect(url_for("admin_verify_page", next="/invoice-generator.html"))
    return send_from_directory(STATIC_DIR, "invoice-generator.html")

# ---------------- Admin APIs (protected) ----------------
@app.get("/admin/api/tickets")
def admin_api_tickets():
    guard = _require_authed_api()
    if guard: return guard

    items = [_merge_ticket(x) for x in _read_submissions()]

    # compute age + overdue (only for non-resolved)
    for it in items:
        it["age_hours"] = _age_hours(it.get("ts",""))
        st = (it.get("status") or "open").lower()
        it["overdue"] = (it["age_hours"] > 20.0) and (st != "resolved")

    # optional filters
    q = (request.args.get("q") or "").lower().strip()
    kind = (request.args.get("kind") or "").strip()
    status = (request.args.get("status") or "").strip()

    def blob(i):
        return json.dumps(i, ensure_ascii=False).lower()

    if kind:
        items = [i for i in items if i.get("kind","")==kind]
    if status:
        items = [i for i in items if i.get("status","")==status]
    if q:
        items = [i for i in items if q in blob(i)]

    # one-time alerts for overdue
    try:
        _maybe_send_overdue_alert(items)
    except Exception as e:
        app.logger.exception("overdue alert pass failed: %s", e)

    return jsonify({"ok": True, "items": items})

@app.get("/admin/api/tickets/<ticket>")
def admin_api_ticket_get(ticket):
    guard = _require_authed_api()
    if guard: return guard
    all_items = {x.get("ticket"): _merge_ticket(x) for x in _read_submissions()}
    it = all_items.get(ticket)
    if not it:
        return jsonify({"ok": False, "error": "Not found"}), 404
    return jsonify({"ok": True, "item": it})

@app.patch("/admin/api/tickets/<ticket>")
def admin_api_ticket_patch(ticket):
    guard = _require_authed_api()
    if guard: return guard
    body = request.get_json(silent=True) or {}
    status = (body.get("status") or "").lower().strip()
    note_provided = "note" in body
    note = (body.get("note") or "").strip()
    email_client = bool(body.get("email_client"))
    email_subject = (body.get("email_subject") or f"Update on Ticket {ticket}").strip()

    if status and status not in ("open","wip","resolved"):
        return jsonify({"ok": False, "error": "Invalid status"}), 400

    # load state & item
    state = _load_state()
    if ticket not in state:
        state[ticket] = {"status":"open","note":"","history":[]}

    old_status = state[ticket]["status"]
    if status:
        state[ticket]["status"] = status
    if note_provided:
        state[ticket]["note"] = note

    # for email we need client email from submissions
    items = {x.get("ticket"): x for x in _read_submissions()}
    item = items.get(ticket, {})
    client_email = item.get("client_email") or (item.get("fields") or {}).get("Email","")
    email_sent = False
    err_msg = None

    if email_client and _valid_email(client_email):
        try:
            inner = f"""
<h2 style="margin:0 0 8px;font:700 18px Arial;color:{BRAND['ink']}">Ticket Update — {ticket}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid {BRAND['line']};border-radius:10px">
  {_row("Ticket", ticket)}
  {_row("Status", (status or old_status).upper())}
  {_row("Remark", note or "(no remarks)")}
</table>
<p style="font:13px Arial;color:{BRAND['muted']}">If you have questions, just reply to this email.</p>
"""
            send_email(email_subject, email_shell_html("Ticket update", inner), to=[client_email], reply_to=BRAND["email"])
            email_sent = True
        except Exception as e:
            app.logger.exception("remark email failed")
            err_msg = str(e)

    # history entry
    history_entry = {
        "ts": datetime.utcnow().isoformat() + "Z",
        "by": session.get("who") or "admin",
        "status": state[ticket]["status"],
        "note": note,
        "email_sent": email_sent
    }
    state[ticket].setdefault("history", []).append(history_entry)
    _save_state(state)

    resp = {"ok": True, "item": _merge_ticket(item), "email_sent": email_sent}
    if err_msg: resp["email_error"] = err_msg
    return jsonify(resp)

# ---------------- Invoice number sequence (server-side, shared) ----------------
# Previously the invoice generator kept its own counter in each browser's
# localStorage, so two different people/devices could each hand out the same
# invoice number. This moves the counter here, guarded by a real OS file
# lock so concurrent requests - even from separate gunicorn worker processes,
# not just threads - can never race and issue a duplicate.
_MONTH_ABBR = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]

def _invoice_fy_month_key(dt: datetime):
    y, m = dt.year, dt.month
    fy_start = y if m >= 4 else y - 1
    fy_short = f"{str(fy_start)[-2:]}-{str(fy_start + 1)[-2:]}"
    return fy_short, _MONTH_ABBR[m - 1]

def _format_invoice_number(fy_short: str, mon_abbr: str, n: int) -> str:
    return f"{INVOICE_PREFIX}/{fy_short}/{mon_abbr}{n:04d}"

def _load_invoice_seq() -> dict:
    if not os.path.exists(INVOICE_SEQ_STATE):
        return {}
    try:
        with open(INVOICE_SEQ_STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _with_invoice_seq_lock(mutate_fn):
    """Read-modify-write invoice_seq.json under an exclusive file lock on a
    sidecar .lock file, so the read-then-write below is atomic across
    concurrent requests regardless of how many worker processes are running."""
    lock_path = INVOICE_SEQ_STATE + ".lock"
    with open(lock_path, "a+") as lockf:
        fcntl.flock(lockf, fcntl.LOCK_EX)
        try:
            seq = _load_invoice_seq()
            result = mutate_fn(seq)
            tmp = INVOICE_SEQ_STATE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(seq, f, ensure_ascii=False, indent=2)
            os.replace(tmp, INVOICE_SEQ_STATE)
            return result
        finally:
            fcntl.flock(lockf, fcntl.LOCK_UN)

@app.get("/admin/api/invoice/next-number")
def admin_api_invoice_peek():
    """Preview only - does not reserve anything. Purely cosmetic, shown while
    a draft is being filled in; the real assignment happens at commit time."""
    guard = _require_authed_api()
    if guard: return guard
    fy_short, mon_abbr = _invoice_fy_month_key(_now_ist())
    key = f"{fy_short}_{mon_abbr}"
    n = _load_invoice_seq().get(key, 0) + 1
    return jsonify({"ok": True, "number": _format_invoice_number(fy_short, mon_abbr, n)})

@app.post("/admin/api/invoice/commit-number")
def admin_api_invoice_commit():
    """Authoritative assignment, called once a bill is actually saved (Download
    PDF). If the caller's current number is still ahead of the server's
    counter, it's honored (respects manual edits); otherwise - including the
    case where another device already claimed it - the next free number is
    issued instead, so two invoices can never end up with the same number."""
    guard = _require_authed_api()
    if guard: return guard
    body = request.get_json(silent=True) or {}
    requested = str(body.get("invoice_number") or "").strip()
    m = re.search(r"(\d+)$", requested)
    requested_n = int(m.group(1)) if m else None

    fy_short, mon_abbr = _invoice_fy_month_key(_now_ist())
    key = f"{fy_short}_{mon_abbr}"

    def mutate(seq):
        current = seq.get(key, 0)
        if requested_n is not None and requested_n > current:
            seq[key] = requested_n
        else:
            seq[key] = current + 1
        return seq[key]

    n = _with_invoice_seq_lock(mutate)
    return jsonify({"ok": True, "number": _format_invoice_number(fy_short, mon_abbr, n)})

# ---------------- Static / Index ----------------
# Only ever serve files out of STATIC_DIR. Never serve arbitrary paths from
# the working directory (that used to expose app.py, .env, submissions.jsonl,
# ticket_state.json, uploads/, etc. to anyone on the internet).
@app.get("/")
def root():
    idx_static = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(idx_static):
        return send_from_directory(STATIC_DIR, "index.html")
    return "OK", 200

@app.get("/<path:path>")
def serve_any(path):
    try:
        return send_from_directory(STATIC_DIR, path)
    except NotFound:
        return "Not found", 404

# ---------------- Keep-alive (avoid Render free-tier spin-down) ----------------
# Render's free web services spin down after ~15 min with no *inbound* HTTP
# traffic. An internal timer alone can't prevent that — only a real request
# hitting the public URL counts. This pings our own public health endpoint
# every KEEP_ALIVE_INTERVAL seconds so the service never goes idle long enough
# to sleep. Started at module level (not inside `if __name__ == "__main__"`)
# so it also runs under gunicorn in production, not just `python app.py`.
KEEP_ALIVE_INTERVAL = int(env("KEEP_ALIVE_INTERVAL", "300"))
SELF_URL = env("SELF_URL") or env("RENDER_EXTERNAL_URL")

def _keep_alive_loop():
    if not SELF_URL:
        return
    ping_url = SELF_URL.rstrip("/") + "/api/health"
    while True:
        time.sleep(KEEP_ALIVE_INTERVAL)
        try:
            urlopen(ping_url, timeout=15).read()
        except URLError as e:
            app.logger.warning("keep-alive ping failed: %s", e)
        except Exception as e:
            app.logger.warning("keep-alive ping error: %s", e)

if (env("KEEP_ALIVE", "1") or "1") == "1" and SELF_URL:
    threading.Thread(target=_keep_alive_loop, daemon=True).start()

# ---------------- Daily health-check email (6:00 AM IST) ----------------
# India Standard Time has no DST, so a fixed UTC+5:30 offset is used instead of
# zoneinfo — avoids depending on a tzdata package being present on the host.
IST_OFFSET = timedelta(hours=5, minutes=30)

def _now_ist() -> datetime:
    return datetime.now(timezone.utc) + IST_OFFSET

def _seconds_until_next_ist_6am() -> float:
    now_ist = _now_ist()
    target = now_ist.replace(hour=6, minute=0, second=0, microsecond=0)
    if target <= now_ist:
        target += timedelta(days=1)
    return (target - now_ist).total_seconds()

def _health_check_already_sent_today(date_str: str) -> bool:
    if not os.path.exists(HEALTH_CHECK_STATE):
        return False
    try:
        with open(HEALTH_CHECK_STATE, "r", encoding="utf-8") as f:
            return json.load(f).get("last_sent_date") == date_str
    except Exception:
        return False

def _mark_health_check_sent(date_str: str):
    tmp = HEALTH_CHECK_STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"last_sent_date": date_str}, f)
    os.replace(tmp, HEALTH_CHECK_STATE)

SCREENSHOT_API_URL = "https://api.microlink.io/"
SCREENSHOT_TIMEOUT = int(env("SCREENSHOT_TIMEOUT", "25"))

def _capture_site_screenshot_jpeg() -> bytes | None:
    """Best-effort live screenshot of the public site, timestamped (IST) in the
    image itself. Uses microlink.io - keyless, synchronous, no browser needed
    on this box (Render's free tier can't comfortably run one in-process).
    Returns None on any failure; the health check email must still send
    without a screenshot rather than fail outright over a secondary feature."""
    try:
        api_url = SCREENSHOT_API_URL + "?" + urlencode({
            "url": BRAND["site"], "screenshot": "true", "meta": "false"
        })
        with urlopen(api_url, timeout=SCREENSHOT_TIMEOUT) as resp:
            meta = json.loads(resp.read().decode("utf-8"))
        shot_url = meta["data"]["screenshot"]["url"]

        with urlopen(shot_url, timeout=SCREENSHOT_TIMEOUT) as resp:
            raw = resp.read()

        img = Image.open(BytesIO(raw)).convert("RGB")
        max_w = 1280
        if img.width > max_w:
            img = img.resize((max_w, round(img.height * max_w / img.width)), Image.LANCZOS)

        stamp = _now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
        text = f"Captured {stamp}"
        draw = ImageDraw.Draw(img, "RGBA")
        font = ImageFont.load_default(size=22)
        pad = 10
        bbox = draw.textbbox((0, 0), text, font=font)
        bar_h = (bbox[3] - bbox[1]) + pad * 2
        draw.rectangle([0, img.height - bar_h, img.width, img.height], fill=(15, 23, 42, 190))
        draw.text((pad, img.height - bar_h + pad // 2), text, font=font, fill=(255, 255, 255, 255))

        out = BytesIO()
        img.save(out, format="JPEG", quality=82)
        return out.getvalue()
    except Exception as e:
        app.logger.warning("site screenshot capture failed: %s", e)
        return None

def send_daily_health_check_email():
    now_ist = _now_ist()
    screenshot = _capture_site_screenshot_jpeg()
    inline_images = None
    if screenshot:
        screenshot_html = f"""
<p style="margin:16px 0 6px;font:700 13px Arial;color:{BRAND['ink']}">Live site screenshot</p>
<img src="cid:site-screenshot.jpg" alt="Live site screenshot" width="100%"
     style="max-width:100%;border:1px solid {BRAND['line']};border-radius:8px;display:block">
"""
        inline_images = [("site-screenshot.jpg", screenshot)]
    else:
        screenshot_html = f'<p style="margin:16px 0 0;font:400 12.5px Arial;color:{BRAND["muted"]}">(Live screenshot unavailable this run.)</p>'

    inner = f"""
<h2 style="margin:0 0 8px;font:700 18px Arial;color:{BRAND['ink']}">✅ Daily Health Check</h2>
<p style="margin:0 0 12px;font:400 14px Arial;color:{BRAND['muted']}">This is an automated confirmation that the AMC Spark website and server are up and running.</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid {BRAND['line']};border-radius:10px">
  {_row("Checked at (IST)", now_ist.strftime("%Y-%m-%d %H:%M:%S"))}
  {_row("Server URL", SELF_URL or "(not configured)")}
  {_row("Mailer", f"Brevo API ({_mask_user(EMAIL_USER)})")}
</table>
{screenshot_html}
"""
    send_email(
        "✅ AMC Spark — Daily Health Check (Server Alive)",
        email_shell_html("Daily health check", inner),
        to=[HEALTH_CHECK_EMAIL],
        inline_images=inline_images
    )

def _daily_health_check_loop():
    while True:
        try:
            time.sleep(_seconds_until_next_ist_6am())
            date_str = _now_ist().strftime("%Y-%m-%d")
            if _health_check_already_sent_today(date_str):
                continue
            send_daily_health_check_email()
            _mark_health_check_sent(date_str)
        except Exception as e:
            app.logger.exception("daily health check failed: %s", e)
            time.sleep(3600)  # back off an hour so a persistent failure can't spin-loop

if (env("DAILY_HEALTH_CHECK", "1") or "1") == "1" and smtp_ready():
    threading.Thread(target=_daily_health_check_loop, daemon=True).start()

@app.post("/admin/api/health-check/test")
def admin_api_health_check_test():
    guard = _require_authed_api()
    if guard: return guard
    try:
        send_daily_health_check_email()
        return jsonify({"ok": True})
    except Exception as e:
        app.logger.exception("manual health check email failed")
        return jsonify({"ok": False, "error": str(e)}), 500

# ---------------- Admin login healthcheck (server-side test-case runner) ----------------
# Runs the same 5 login/logout/wrong-password test cases as
# qa/admin_login_test.js, but via Flask's own test client instead of real
# HTTP requests. This process runs behind a single gunicorn worker with no
# threading (see the keep-alive comment above) - an actual outbound HTTP
# call from a view function back to this same server would have nowhere to
# be served and could hang the whole app until it timed out. The test
# client runs the exact same view functions in-process over WSGI, with its
# own independent cookie jar, so it doesn't touch the admin's real session
# and carries zero risk of that deadlock. No screenshots/video, since there
# is no browser in this environment - use the Node script locally for that.
_LOGIN_HEALTHCHECK_WRONG_PASS = "Wr0ng-Test-Password!Not-Real"

def _run_login_healthcheck():
    results = []
    def check(tc_id, name, passed, note=""):
        results.append({"id": tc_id, "name": name, "passed": bool(passed), "note": note})

    client = app.test_client()
    REDIRECT_CODES = (301, 302, 303, 307, 308)

    try:
        r = client.get("/")
        has_link = b"invoice-generator.html" in r.data
        r2 = client.get("/invoice-generator.html")
        loc2 = r2.headers.get("Location", "")
        tc1 = has_link and r2.status_code in REDIRECT_CODES and loc2.endswith("/admin/login")
        check("TC1", "Office Use Only link exists and requires login", tc1,
              f"homepage links to it: {has_link}; unauthenticated visit -> {loc2 or r2.status_code}")

        r = client.post("/admin/login", data={"user": ADMIN_USER_ID, "pass": ADMIN_PASS})
        loc = r.headers.get("Location", "")
        tc2 = r.status_code in REDIRECT_CODES and loc.endswith("/admin")
        check("TC2", "Valid credentials log in successfully", tc2, f"redirected to {loc}")

        client.get("/admin/logout")
        r = client.get("/admin")
        loc = r.headers.get("Location", "")
        tc3 = r.status_code in REDIRECT_CODES and loc.endswith("/admin/login")
        check("TC3", "Logout ends the session", tc3, f"/admin now redirects to {loc}")

        r = client.post("/admin/login", data={"user": ADMIN_USER_ID, "pass": _LOGIN_HEALTHCHECK_WRONG_PASS})
        loc = r.headers.get("Location", "")
        tc4 = r.status_code in REDIRECT_CODES and "/admin/login" in loc
        check("TC4", "Incorrect password is rejected", tc4, f"redirected to {loc}")

        r = client.post("/admin/login", data={"user": ADMIN_USER_ID, "pass": ADMIN_PASS})
        loc = r.headers.get("Location", "")
        tc5 = r.status_code in REDIRECT_CODES and loc.endswith("/admin")
        check("TC5", "Only the correct password is ever accepted (re-confirmed)", tc5, f"redirected to {loc}")
    except Exception as e:
        check("ERROR", "Test run crashed partway through", False, str(e))

    return results

def _login_healthcheck_email_html(results, passed, total):
    def row(x):
        status = "PASS" if x["passed"] else "FAIL"
        color = BRAND["ok"] if x["passed"] else BRAND["danger"]
        return f"""<tr>
  <td style="padding:8px 10px;border-bottom:1px solid {BRAND['line']};font:800 12px Arial;color:{color};width:56px">{status}</td>
  <td style="padding:8px 10px;border-bottom:1px solid {BRAND['line']};font:700 13px Arial;width:44px">{x['id']}</td>
  <td style="padding:8px 10px;border-bottom:1px solid {BRAND['line']};font:400 13px Arial">{x['name']}<br><span style="color:{BRAND['muted']};font-size:11.5px">{x['note']}</span></td>
</tr>"""
    all_passed = passed == total
    inner = f"""
<h2 style="margin:0 0 8px;font:700 18px Arial;color:{BRAND['ink']}">{"✅" if all_passed else "⚠️"} Admin Login Healthcheck</h2>
<p style="margin:0 0 12px;font:400 14px Arial;color:{BRAND['muted']}">Ran at {_now_ist().strftime('%Y-%m-%d %H:%M:%S')} IST. Result: <b>{passed}/{total} passed</b>.</p>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid {BRAND['line']};border-radius:10px">
{''.join(row(x) for x in results)}
</table>
<p style="margin:14px 0 0;font:400 12px Arial;color:{BRAND['muted']}">Runs entirely in-process against this server (Flask's test client) - no screenshots, since this environment has no browser.</p>
"""
    return email_shell_html("Admin login healthcheck", inner)

@app.post("/admin/api/login-healthcheck")
def admin_api_login_healthcheck():
    guard = _require_authed_api()
    if guard: return guard

    results = _run_login_healthcheck()
    passed = sum(1 for r in results if r["passed"])
    total = len(results)

    email_sent, email_err = False, None
    try:
        send_email(f"Admin Login Healthcheck — {passed}/{total} passed",
                    _login_healthcheck_email_html(results, passed, total),
                    to=[HEALTH_CHECK_EMAIL])
        email_sent = True
    except Exception as e:
        app.logger.exception("login healthcheck email failed")
        email_err = str(e)

    resp = {"ok": True, "passed": passed, "total": total, "results": results, "email_sent": email_sent}
    if email_err: resp["email_error"] = email_err
    return jsonify(resp)

def _dispatch_github_workflow(base_url: str):
    """Kick off the login-healthcheck GitHub Actions workflow (screenshots +
    video, on a real runner) via workflow_dispatch. Fire-and-forget: GitHub
    queues the run and answers 204 immediately, well before the workflow
    itself (which takes a couple of minutes) finishes."""
    url = f"https://api.github.com/repos/{GITHUB_REPO}/actions/workflows/{GITHUB_WORKFLOW_FILE}/dispatches"
    payload = {"ref": GITHUB_DISPATCH_REF, "inputs": {"base_url": base_url}}
    req = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {GITHUB_DISPATCH_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "amc-spark-admin-dashboard",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=15) as resp:
            resp.read()
    except HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"GitHub API error {e.code}: {detail}") from e
    except URLError as e:
        raise RuntimeError(f"GitHub API unreachable: {e.reason}") from e

@app.post("/admin/api/login-healthcheck/video")
def admin_api_login_healthcheck_video():
    guard = _require_authed_api()
    if guard: return guard

    if not GITHUB_DISPATCH_TOKEN:
        return jsonify({"ok": False, "error": "GITHUB_DISPATCH_TOKEN not configured on this server"}), 500

    base_url = request.url_root.rstrip("/")
    try:
        _dispatch_github_workflow(base_url)
    except Exception as e:
        app.logger.exception("login healthcheck video dispatch failed")
        return jsonify({"ok": False, "error": str(e)}), 502

    return jsonify({
        "ok": True,
        "message": f"Started - testing {base_url}. Screenshots + video will land at {HEALTH_CHECK_EMAIL} in a few minutes.",
    })

# ---------------- Run ----------------
if __name__ == "__main__":
    app.logger.info(
        "Starting on %s (mailer=brevo_api, user=%s, ready=%s)",
        PORT, _mask_user(EMAIL_USER), smtp_ready()
    )
    app.run(host="0.0.0.0", port=PORT, debug=True)
