# app.py — AMC Spark & Services
# SMTP emails + JSON logging + Admin dashboard (auth + status/remarks/email + overdue alerts)

import os, re, ssl, smtplib, hashlib, json
from datetime import datetime, timezone
from email.message import EmailMessage

from flask import (
    Flask, request, jsonify, send_from_directory, redirect,
    url_for, session
)
from werkzeug.utils import secure_filename

# ---------------- .env loader (optional) ----------------
DOTENV = {}
try:
    from dotenv import dotenv_values
    DOTENV = dotenv_values(os.path.join(os.getcwd(), ".env")) or {}
except Exception:
    DOTENV = {}

def env(key, default=None):
    return DOTENV.get(key) if DOTENV.get(key) is not None else os.getenv(key, default)

# ---------------- Config ----------------
PORT            = int(env("PORT", "5000"))
STATIC_DIR      = env("STATIC_DIR", "static")
UPLOAD_DIR      = env("UPLOAD_DIR", "uploads") or "uploads"
INDEX_FILE      = env("INDEX_FILE", "static/index.html")  # default simplified

SMTP_HOST       = env("SMTP_HOST", "smtpout.secureserver.net")
SMTP_PORT       = int(env("SMTP_PORT", "465"))
SMTP_SECURE     = (env("SMTP_SECURE", "ssl") or "ssl").lower()  # ssl | starttls
EMAIL_USER      = env("EMAIL_USER")
EMAIL_PASSWORD  = env("EMAIL_PASSWORD")
SMTP_FROM       = env("SMTP_FROM", EMAIL_USER or "no-reply@localhost")
ADMIN_EMAIL     = env("ADMIN_EMAIL", EMAIL_USER or "")
HR_EMAIL        = env("HR_EMAIL", "")
SMTP_DEBUG      = int(env("SMTP_DEBUG", "0"))

MAX_EMAIL_MB    = int(env("MAX_EMAIL_MB", "19"))
MAX_EMAIL_BYTES = MAX_EMAIL_MB * 1024 * 1024

ALLOWED_EXTS    = {".pdf",".doc",".docx",".xls",".xlsx",".csv",".zip",".png",".jpg",".jpeg",".txt"}

# Admin auth + logs/state
SECRET_KEY      = env("SECRET_KEY", "please_change_me")
ADMIN_USER_ID   = env("ADMIN_USER", "admin")
ADMIN_PASS      = env("ADMIN_PASS", "password")
SUBMIT_LOG      = env("SUBMIT_LOG", "submissions.jsonl")     # supports .jsonl and .json
SUBMIT_STATE    = env("SUBMIT_STATE", "ticket_state.json")   # stores status/remarks/history
ALERT_EMAIL     = env("ALERT_EMAIL", "info@amcspark.com")    # overdue alerts recipient

os.makedirs(UPLOAD_DIR, exist_ok=True)

# Guard: common misconfig with GoDaddy SMTP + Gmail sender
if "secureserver.net" in (SMTP_HOST or "").lower() and EMAIL_USER and EMAIL_USER.lower().endswith("@gmail.com"):
    raise RuntimeError("Use your domain mailbox with GoDaddy SMTP (e.g. info@amcspark.com), not Gmail.")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["SECRET_KEY"] = SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = (MAX_EMAIL_MB + 5) * 1024 * 1024

# ---------------- Branding ----------------
BRAND = {
    "name": "AMC Spark & Services",
    "brand": "#0ea5ff",
    "brand2": "#22c55e",
    "ink": "#0f172a",
    "muted": "#475569",
    "bg": "#f6f8fb",
    "line": "#e5e7eb",
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

# ---------------- SMTP ----------------
def smtp_ready() -> bool:
    return bool(SMTP_HOST and EMAIL_USER and EMAIL_PASSWORD and SMTP_PORT > 0)

def send_email(subject: str, html_body: str, *, to, reply_to=None, cc=None, bcc=None):
    if not EMAIL_USER:      raise RuntimeError("EMAIL_USER not set")
    if not EMAIL_PASSWORD:  raise RuntimeError("EMAIL_PASSWORD not set")

    def norm_list(x):
        if not x: return []
        if isinstance(x, list): return [i.strip() for i in x if i and i.strip()]
        if isinstance(x, str):  return [i.strip() for i in x.split(",") if i.strip()]
        return []

    to_list  = norm_list(to)
    cc_list  = norm_list(cc)
    bcc_list = norm_list(bcc)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = SMTP_FROM
    msg["To"]      = ", ".join(to_list)
    if cc_list:    msg["Cc"] = ", ".join(cc_list)
    if reply_to:   msg["Reply-To"] = reply_to

    msg.set_content(_plain_from_html(html_body))
    msg.add_alternative(html_body, subtype="html")

    if SMTP_SECURE == "ssl":
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=60) as s:
            s.set_debuglevel(SMTP_DEBUG)
            s.login(EMAIL_USER, EMAIL_PASSWORD)
            s.send_message(msg)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=60) as s:
            s.set_debuglevel(SMTP_DEBUG)
            s.ehlo(); s.starttls(context=ssl.create_default_context()); s.ehlo()
            s.login(EMAIL_USER, EMAIL_PASSWORD)
            s.send_message(msg)

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
        "smtp_host": SMTP_HOST,
        "secure": SMTP_SECURE,
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
    if user == ADMIN_USER_ID and pwd == ADMIN_PASS:
        session["authed"] = True
        session["who"] = ADMIN_USER_ID
        return redirect(url_for("admin_dashboard_page"))
    return redirect(url_for("admin_login_page"))

@app.get("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login_page"))

@app.get("/admin")
def admin_dashboard_page():
    if not _is_authed():
        return redirect(url_for("admin_login_page"))
    return send_from_directory(STATIC_DIR, "admin.html")

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
    note   = (body.get("note") or "").strip()
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
    if note is not None:
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

# ---------------- Static / Index ----------------
@app.get("/")
def root():
    # Try INDEX_FILE (absolute/relative); else static/index.html; else OK
    idx_path = INDEX_FILE
    if os.path.isabs(idx_path):
        if os.path.exists(idx_path):
            directory, fname = os.path.split(idx_path)
            return send_from_directory(directory, fname)
    else:
        abs_path = os.path.join(os.getcwd(), idx_path)
        if os.path.exists(abs_path):
            directory, fname = os.path.split(abs_path)
            return send_from_directory(directory, fname)

    idx_static = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(idx_static):
        return send_from_directory(STATIC_DIR, "index.html")
    return "OK", 200

@app.get("/<path:path>")
def serve_any(path):
    # serve absolute path if exists
    root_path = os.path.join(os.getcwd(), path)
    if os.path.isfile(root_path):
        directory, fname = os.path.split(root_path)
        return send_from_directory(directory, fname)
    # serve from static if exists
    static_path = os.path.join(STATIC_DIR, path)
    if os.path.isfile(static_path):
        directory, fname = os.path.split(static_path)
        return send_from_directory(directory, fname)
    return "Not found", 404

# ---------------- Run ----------------
if __name__ == "__main__":
    app.logger.info(
        "Starting on %s (smtp=%s, secure=%s, user=%s)",
        PORT, SMTP_HOST, SMTP_SECURE, _mask_user(EMAIL_USER)
    )
    app.run(host="0.0.0.0", port=PORT, debug=True)
