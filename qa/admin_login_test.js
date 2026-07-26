/**
 * QA test: admin login flow on the live "Office Use Only" (invoice generator)
 * page - valid credentials succeed, logout actually ends the session, and
 * invalid credentials are rejected. Captures a timestamped, URL-stamped
 * screenshot at every step, records a real-time video of the whole run (same
 * live timestamp+URL banner burned into every frame), and can email the
 * whole run (report + screenshots + video, zipped) as a report.
 *
 * Nothing here is deployed anywhere - it's a standalone script you run
 * against a live site from your own machine. It does not touch the repo's
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
 *   QA_RECORD_VIDEO     "0" to skip video recording (default "1"). Needs
 *                        ffmpeg on PATH (e.g. `brew install ffmpeg`) - if
 *                        ffmpeg isn't found, the run continues without a
 *                        video rather than failing outright.
 *   QA_SEND_EMAIL       "1" to email the report (needs QA_BREVO_API_KEY,
 *                        QA_EMAIL_FROM, QA_EMAIL_TO)
 *   QA_BREVO_API_KEY, QA_EMAIL_FROM, QA_EMAIL_TO
 *
 * Run: node qa/admin_login_test.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const BASE_URL      = process.env.QA_BASE_URL || 'https://www.amcspark.com';
const CDP_PORT       = process.env.QA_CDP_PORT || '9222';
const ADMIN_USER     = process.env.QA_ADMIN_USER;
const ADMIN_PASS     = process.env.QA_ADMIN_PASS;
const WRONG_PASS     = 'Wr0ng-Test-Password!Not-Real';
const OUT_DIR        = process.env.QA_OUT_DIR || path.join(__dirname, 'qa-run-' + new Date().toISOString().replace(/[:.]/g, '-'));
const RECORD_VIDEO   = (process.env.QA_RECORD_VIDEO || '1') === '1';

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('QA_ADMIN_USER and QA_ADMIN_PASS must be set in the environment (never hardcode credentials in this file).');
  process.exit(1);
}

const FRAMES_DIR = path.join(OUT_DIR, 'frames');
fs.mkdirSync(OUT_DIR, { recursive: true });
if (RECORD_VIDEO) fs.mkdirSync(FRAMES_DIR, { recursive: true });

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const results = [];   // { id, name, passed, note }
const shots = [];      // { file, label }

function record(id, name, passed, note) {
  results.push({ id, name, passed, note: note || '' });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${id} - ${name}${note ? ' :: ' + note : ''}`);
}

async function main() {
  const ffmpegOk = RECORD_VIDEO && hasFfmpeg();
  if (RECORD_VIDEO && !ffmpegOk) {
    console.warn('QA_RECORD_VIDEO=1 but ffmpeg was not found on PATH - continuing without video (install with `brew install ffmpeg`).');
  }

  const listRes = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const tabs = await listRes.json();
  const tab = tabs.find(t => t.type === 'page') || tabs[0];
  if (!tab) throw new Error(`No page target found on CDP port ${CDP_PORT} - is headless Chrome running with --remote-debugging-port=${CDP_PORT}?`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

  let frameIndex = 0;
  const frameTimestamps = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg.result); }
    if (msg.method === 'Page.screencastFrame') {
      const { data, sessionId } = msg.params;
      const fname = path.join(FRAMES_DIR, String(frameIndex).padStart(6, '0') + '.jpg');
      fs.writeFileSync(fname, Buffer.from(data, 'base64'));
      frameTimestamps.push(Date.now());
      frameIndex++;
      send('Page.screencastFrameAck', { sessionId });
    }
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
  const VIEW_W = 1280, VIEW_H = 900;
  await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1.5, mobile: false });

  // Live timestamp+URL banner, re-injected automatically on every navigation
  // (form submits/redirects included) - this is what makes both the
  // screenshots AND every frame of the video independently verifiable.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function(){
      function ensureBanner(){
        if (document.getElementById('__qa_banner')) return;
        var b = document.createElement('div');
        b.id = '__qa_banner';
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b1220;color:#22e07a;font:700 13px/1.5 "SF Mono",Consolas,monospace;padding:8px 12px;white-space:pre-wrap;border-bottom:3px solid #22e07a;pointer-events:none';
        document.documentElement.appendChild(b);
        function tick(){
          var el = document.getElementById('__qa_banner');
          if (!el) return;
          el.textContent = 'QA TEST RECORDING\\nTimestamp: ' + new Date().toISOString() + '\\nURL: ' + location.href;
        }
        tick();
        setInterval(tick, 200);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureBanner);
      else ensureBanner();
    })();`
  });

  if (ffmpegOk) {
    await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1 });
  }

  async function shot(label) {
    await new Promise(r => setTimeout(r, 150)); // let the banner's tick() paint the latest timestamp
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, label + '.png');
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    shots.push({ file, label });
    console.log('screenshot:', label, '| url:', await ev('location.href'));
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

  let videoPath = null;
  if (ffmpegOk) {
    await send('Page.stopScreencast');
    await new Promise(r => setTimeout(r, 200)); // let any in-flight frame finish writing
    videoPath = buildVideo(frameTimestamps);
  }

  ws.close();

  // ---- report ----
  const passCount = results.filter(r => r.passed).length;
  const summary = `AMC Spark - Admin Login QA Report
Run at: ${new Date().toISOString()}
Target: ${BASE_URL}
Video: ${videoPath ? 'included (' + frameIndex + ' frames)' : (RECORD_VIDEO ? 'skipped - ffmpeg not found' : 'skipped (QA_RECORD_VIDEO=0)')}

Result: ${passCount}/${results.length} test cases passed

${results.map(r => `[${r.passed ? 'PASS' : 'FAIL'}] ${r.id} - ${r.name}${r.note ? '\n       ' + r.note : ''}`).join('\n')}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), summary);
  console.log('\n' + summary);

  const zipPath = OUT_DIR + '.zip';
  const zipInputs = ['*.png', 'report.txt'];
  if (videoPath) zipInputs.push(path.basename(videoPath));
  execSync(`cd ${JSON.stringify(OUT_DIR)} && zip -j ${JSON.stringify(zipPath)} ${zipInputs.join(' ')}`);
  console.log('Zipped report:', zipPath);
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true }); // raw frames aren't needed once the video is built

  if (process.env.QA_SEND_EMAIL === '1') {
    await sendReportEmail(summary, zipPath, passCount, results.length);
  }

  function buildVideo(timestamps) {
    if (timestamps.length < 2) { console.warn('Not enough frames captured to build a video.'); return null; }
    const listFile = path.join(OUT_DIR, 'frames.txt');
    const lines = [];
    for (let i = 0; i < timestamps.length; i++) {
      const frameFile = path.join('frames', String(i).padStart(6, '0') + '.jpg');
      const dur = i < timestamps.length - 1 ? Math.max(0.04, (timestamps[i + 1] - timestamps[i]) / 1000) : 1.0;
      lines.push(`file '${frameFile}'`);
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    // ffmpeg's concat demuxer ignores the last entry's duration - repeat the final frame so it still displays.
    lines.push(`file '${path.join('frames', String(timestamps.length - 1).padStart(6, '0') + '.jpg')}'`);
    fs.writeFileSync(listFile, lines.join('\n'));
    const out = path.join(OUT_DIR, 'test-recording.mp4');
    try {
      execSync(`ffmpeg -y -f concat -safe 0 -i ${JSON.stringify(listFile)} -vf "scale=${VIEW_W}:-2,format=yuv420p" -movflags +faststart ${JSON.stringify(out)}`,
        { cwd: OUT_DIR, stdio: 'pipe' });
      console.log('Video built:', out);
      return out;
    } catch (e) {
      console.error('ffmpeg failed, continuing without video:', e.message);
      return null;
    }
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
