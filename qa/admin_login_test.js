/**
 * QA test: admin login flow on the live "Office Use Only" (invoice generator)
 * page - valid credentials succeed, logout actually ends the session, and
 * invalid credentials are rejected. Captures a timestamped, URL-stamped
 * screenshot at every step and can email the whole run (zipped) as a report.
 *
 * Nothing here is deployed anywhere - it's a standalone script you run
 * against the live site from your own machine. It does not touch the repo's
 * app code.
 *
 * Requires (env vars, never hardcode these):
 *   QA_ADMIN_USER      - real admin username
 *   QA_ADMIN_PASS      - real admin password
 * Optional:
 *   QA_BASE_URL         (default https://www.amcspark.com)
 *   QA_CDP_PORT         (default 9222) - a headless Chrome must already be
 *                        running with --remote-debugging-port on this port,
 *                        e.g.:
 *                        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *                          --headless=new --disable-gpu \
 *                          --remote-debugging-port=9222 \
 *                          --user-data-dir=/tmp/qa-chrome-profile about:blank
 *   QA_OUT_DIR          (default ./qa-run-<timestamp> next to this script)
 *   QA_SEND_EMAIL       "1" to email the report (needs QA_BREVO_API_KEY,
 *                        QA_EMAIL_FROM, QA_EMAIL_TO)
 *   QA_BREVO_API_KEY, QA_EMAIL_FROM, QA_EMAIL_TO
 *
 * Run: node qa/admin_login_test.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL   = process.env.QA_BASE_URL || 'https://www.amcspark.com';
const CDP_PORT    = process.env.QA_CDP_PORT || '9222';
const ADMIN_USER  = process.env.QA_ADMIN_USER;
const ADMIN_PASS  = process.env.QA_ADMIN_PASS;
const WRONG_PASS  = 'Wr0ng-Test-Password!Not-Real';
const OUT_DIR     = process.env.QA_OUT_DIR || path.join(__dirname, 'qa-run-' + new Date().toISOString().replace(/[:.]/g, '-'));

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('QA_ADMIN_USER and QA_ADMIN_PASS must be set in the environment (never hardcode credentials in this file).');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];   // { id, name, passed, note }
const shots = [];      // { file, label }

function record(id, name, passed, note) {
  results.push({ id, name, passed, note: note || '' });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${id} - ${name}${note ? ' :: ' + note : ''}`);
}

async function main() {
  const listRes = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const tabs = await listRes.json();
  const tab = tabs.find(t => t.type === 'page') || tabs[0];
  if (!tab) throw new Error(`No page target found on CDP port ${CDP_PORT} - is headless Chrome running with --remote-debugging-port=${CDP_PORT}?`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg.result); }
  });
  function send(method, params = {}) {
    const myId = ++id;
    return new Promise((resolve) => { pending.set(myId, { resolve }); ws.send(JSON.stringify({ id: myId, method, params })); });
  }
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true });
    if (r.exceptionDetails) { console.error('JS error:', JSON.stringify(r.exceptionDetails)); return null; }
    return r.result.value;
  }
  async function goto(url) {
    await send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 1200));
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1.5, mobile: false });

  async function shot(label) {
    const timestamp = new Date().toISOString();
    const url = await ev('location.href');
    await ev(`
      (function(){
        var old = document.getElementById('__qa_banner');
        if (old) old.remove();
        var b = document.createElement('div');
        b.id = '__qa_banner';
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b1220;color:#22e07a;font:700 13px/1.5 "SF Mono",Consolas,monospace;padding:8px 12px;white-space:pre-wrap;border-bottom:3px solid #22e07a';
        b.textContent = 'QA TEST CAPTURE\\nTimestamp: ${timestamp}\\nURL: ' + location.href;
        document.documentElement.appendChild(b);
      })()
    `);
    await new Promise(r => setTimeout(r, 150));
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, label + '.png');
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    await ev(`document.getElementById('__qa_banner')?.remove()`);
    shots.push({ file, label });
    console.log('screenshot:', label, '| url:', url, '| t:', timestamp);
  }

  // ---- TC1: reach the login page via the real "Office Use Only" journey ----
  await goto(BASE_URL + '/');
  const officeLink = await ev(`(function(){
    const a = Array.from(document.querySelectorAll('a')).find(x => /office use only/i.test(x.textContent));
    return a ? a.getAttribute('href') : null;
  })()`);
  // The footer link opens in a new tab (target=_blank) on the live site;
  // rather than juggle a second CDP target for what is otherwise an
  // identical navigation, we verify the link exists on the homepage and
  // then follow its destination directly in this same tab.
  const destination = officeLink ? new URL(officeLink, BASE_URL + '/').href : null;
  await goto(destination || (BASE_URL + '/invoice-generator.html'));
  const onLoginPage = await ev(`!!(document.getElementById('user') && document.getElementById('pass') && document.querySelector('form'))`);
  record('TC1', 'Office Use Only link leads to the admin login page (auth required)', !!officeLink && !!onLoginPage,
    officeLink ? `link -> ${destination}` : 'Office Use Only link not found on homepage');
  await shot('01-login-page');

  // ---- TC2: valid credentials authenticate successfully ----
  await ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
             document.getElementById('pass').value = ${JSON.stringify(ADMIN_PASS)};`);
  await shot('02-credentials-entered');
  await ev(`document.querySelector('form').submit()`);
  await new Promise(r => setTimeout(r, 1000));
  let onDashboard = await ev(`location.pathname === '/admin' && !!document.querySelector('.side, .dash')`);
  record('TC2', 'Valid credentials log in successfully', !!onDashboard, 'landed on ' + await ev('location.pathname'));
  await shot('03-login-success-dashboard');

  // ---- TC3: logout actually ends the session ----
  const loggedOut = await ev(`(function(){
    const a = Array.from(document.querySelectorAll('a')).find(x => /log ?out/i.test(x.textContent));
    if (a) { location.href = a.href; return true; }
    return false;
  })()`);
  await new Promise(r => setTimeout(r, 1000));
  await goto(BASE_URL + '/admin'); // should now bounce back to login if session really ended
  const sessionEnded = await ev(`location.pathname === '/admin/login'`);
  record('TC3', 'Logout ends the session (direct /admin access now redirects to login)', !!loggedOut && !!sessionEnded,
    'logout link clicked: ' + loggedOut + ', post-logout /admin -> ' + await ev('location.pathname'));
  await shot('04-after-logout');

  // ---- TC4: invalid credentials are rejected ----
  await ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
             document.getElementById('pass').value = ${JSON.stringify(WRONG_PASS)};
             document.querySelector('form').submit();`);
  await new Promise(r => setTimeout(r, 1000));
  const rejectedCorrectly = await ev(`location.pathname === '/admin/login'`);
  record('TC4', 'Incorrect password is rejected', !!rejectedCorrectly, 'landed on ' + await ev('location.pathname'));
  await shot('05-wrong-password-rejected');

  // ---- TC5: correct password still works after a failed attempt ----
  await ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
             document.getElementById('pass').value = ${JSON.stringify(ADMIN_PASS)};
             document.querySelector('form').submit();`);
  await new Promise(r => setTimeout(r, 1000));
  onDashboard = await ev(`location.pathname === '/admin' && !!document.querySelector('.side, .dash')`);
  record('TC5', 'Only the correct password is ever accepted (re-confirmed after a bad attempt)', !!onDashboard,
    'landed on ' + await ev('location.pathname'));
  await shot('06-correct-password-reconfirmed');

  ws.close();

  // ---- report ----
  const passCount = results.filter(r => r.passed).length;
  const summary = `AMC Spark - Admin Login QA Report
Run at: ${new Date().toISOString()}
Target: ${BASE_URL}

Result: ${passCount}/${results.length} test cases passed

${results.map(r => `[${r.passed ? 'PASS' : 'FAIL'}] ${r.id} - ${r.name}${r.note ? '\n       ' + r.note : ''}`).join('\n')}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), summary);
  console.log('\n' + summary);

  const zipPath = OUT_DIR + '.zip';
  execSync(`cd ${JSON.stringify(OUT_DIR)} && zip -j ${JSON.stringify(zipPath)} *.png report.txt`);
  console.log('Zipped report:', zipPath);

  if (process.env.QA_SEND_EMAIL === '1') {
    await sendReportEmail(summary, zipPath, passCount, results.length);
  }
}

async function sendReportEmail(summary, zipPath, passCount, totalCount) {
  const apiKey = process.env.QA_BREVO_API_KEY;
  const from = process.env.QA_EMAIL_FROM;
  const to = process.env.QA_EMAIL_TO;
  if (!apiKey || !from || !to) {
    console.log('QA_SEND_EMAIL=1 but QA_BREVO_API_KEY/QA_EMAIL_FROM/QA_EMAIL_TO not all set - skipping email.');
    return;
  }
  const zipB64 = fs.readFileSync(zipPath).toString('base64');
  const htmlBody = '<pre style="font:13px monospace;white-space:pre-wrap">' +
    summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
  const payload = {
    sender: { name: 'AMC Spark QA', email: from },
    to: [{ email: to }],
    subject: `AMC Spark Admin Login QA Report - ${passCount}/${totalCount} passed`,
    htmlContent: htmlBody,
    textContent: summary,
    attachment: [{ name: path.basename(zipPath), content: zipB64 }],
  };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log('Email send status:', res.status, body);
}

main().catch(e => { console.error(e); process.exit(1); });
