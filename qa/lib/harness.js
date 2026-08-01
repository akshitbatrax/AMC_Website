/**
 * Shared QA harness: CDP connection, timestamp+URL banner injection,
 * screenshotting, real-time video recording, zip packaging, and email
 * delivery. Extracted from admin_login_test.js so other QA scripts (e.g.
 * full_site_test.js) don't duplicate this infrastructure.
 *
 * Requires a headless Chrome already running with --remote-debugging-port
 * (see admin_login_test.js's header comment for the exact launch command).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function hasFfmpeg() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; }
}

const BANNER_SCRIPT = `(function(){
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
})();`;

/**
 * Opens one CDP session against a fresh (or existing) page target and
 * returns helpers for driving it. Call finish() once at the end to stop the
 * screencast (if recording), build the video, close the socket, and clean
 * up raw frames.
 */
async function createSession({ cdpPort, outDir, recordVideo = true, width = 1280, height = 900, mobile = false }) {
  fs.mkdirSync(outDir, { recursive: true });
  const framesDir = path.join(outDir, 'frames');
  const ffmpegOk = recordVideo && hasFfmpeg();
  if (recordVideo && !ffmpegOk) {
    console.warn('Video recording requested but ffmpeg was not found on PATH - continuing without video.');
  }
  if (ffmpegOk) fs.mkdirSync(framesDir, { recursive: true });

  const listRes = await fetch(`http://localhost:${cdpPort}/json/list`);
  const tabs = await listRes.json();
  const tab = tabs.find(t => t.type === 'page') || tabs[0];
  if (!tab) throw new Error(`No page target found on CDP port ${cdpPort} - is headless Chrome running with --remote-debugging-port=${cdpPort}?`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

  let frameIndex = 0;
  const frameTimestamps = [];

  ws.addEventListener('message', (rawEv) => {
    const msg = JSON.parse(rawEv.data);
    if (msg.id && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg.result); }
    if (msg.method === 'Page.screencastFrame') {
      const { data, sessionId } = msg.params;
      const fname = path.join(framesDir, String(frameIndex).padStart(6, '0') + '.jpg');
      fs.writeFileSync(fname, Buffer.from(data, 'base64'));
      frameTimestamps.push(Date.now());
      frameIndex++;
      send('Page.screencastFrameAck', { sessionId });
    }
  });

  function send(method, params = {}) {
    const myId = ++msgId;
    return new Promise((resolve) => { pending.set(myId, { resolve }); ws.send(JSON.stringify({ id: myId, method, params })); });
  }
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true });
    if (r.exceptionDetails) { console.error('JS error:', JSON.stringify(r.exceptionDetails)); return null; }
    return r.result.value;
  }
  async function goto(url) {
    await send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 1200));
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  // Each session starts logged out, regardless of what a previous session
  // (or a previous run reusing the same long-lived Chrome profile) left
  // behind - otherwise an inherited admin cookie can make an
  // unauthenticated-access test pass or fail for the wrong reason.
  await send('Network.clearBrowserCookies');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1.5, mobile });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: BANNER_SCRIPT });

  if (ffmpegOk) {
    await send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  }

  const shots = [];
  async function shot(label) {
    await new Promise(r => setTimeout(r, 150)); // let the banner's tick() paint the latest timestamp
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, label + '.png');
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    shots.push({ file, label });
    console.log('screenshot:', label, '| url:', await ev('location.href'));
    return file;
  }

  async function noHorizontalOverflow() {
    return await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  }

  // Polls a JS expression until it returns a truthy value or timeoutMs
  // elapses - for waiting out an async fetch (e.g. a form's "Sending..."
  // status) without guessing a fixed delay that can race on slower
  // responses (cold starts, network jitter).
  async function waitFor(expression, { timeoutMs = 8000, intervalMs = 250 } = {}) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
      last = await ev(expression);
      if (last) return last;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return last;
  }

  async function finish() {
    let videoPath = null;
    if (ffmpegOk) {
      await send('Page.stopScreencast');
      await new Promise(r => setTimeout(r, 200)); // let any in-flight frame finish writing
      videoPath = buildVideo(frameTimestamps, { framesDir, outDir, width });
    }
    ws.close();
    if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
    return { videoPath, frameCount: frameIndex };
  }

  return { send, ev, goto, shot, noHorizontalOverflow, waitFor, finish, shots };
}

function buildVideo(timestamps, { framesDir, outDir, width }) {
  if (timestamps.length < 2) { console.warn('Not enough frames captured to build a video.'); return null; }
  const listFile = path.join(outDir, 'frames.txt');
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
  const out = path.join(outDir, 'test-recording.mp4');
  try {
    execSync(`ffmpeg -y -f concat -safe 0 -i ${JSON.stringify(listFile)} -vf "scale=${width}:-2,format=yuv420p" -movflags +faststart ${JSON.stringify(out)}`,
      { cwd: outDir, stdio: 'pipe' });
    console.log('Video built:', out);
    return out;
  } catch (e) {
    console.error('ffmpeg failed, continuing without video:', e.message);
    return null;
  }
}

function zipRun(outDir, extraFiles = []) {
  const zipPath = outDir + '.zip';
  const zipInputs = ['*.png', 'report.txt', ...extraFiles.map(f => JSON.stringify(path.basename(f)))];
  execSync(`cd ${JSON.stringify(outDir)} && zip -j ${JSON.stringify(zipPath)} ${zipInputs.join(' ')}`);
  console.log('Zipped report:', zipPath);
  return zipPath;
}

async function sendReportEmail({ apiKey, from, to, subject, summary, zipPath }) {
  if (!apiKey || !from || !to) {
    console.log('Email requested but QA_BREVO_API_KEY/QA_EMAIL_FROM/QA_EMAIL_TO not all set - skipping.');
    return;
  }
  const zipB64 = fs.readFileSync(zipPath).toString('base64');
  const htmlBody = '<pre style="font:13px monospace;white-space:pre-wrap">' +
    summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
  const payload = {
    sender: { name: 'AMC Spark QA', email: from },
    to: [{ email: to }],
    subject,
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

/**
 * Downscales a screenshot for email embedding via ffmpeg (already a
 * dependency for video building, so this adds nothing new to install
 * locally or in CI). Returns null if ffmpeg isn't available or the
 * conversion fails - callers should treat that as "skip this image"
 * rather than fail the whole report.
 */
function shrinkForEmail(srcPngPath, { maxWidth = 640, quality = 6 } = {}) {
  if (!hasFfmpeg()) return null;
  const outPath = srcPngPath.replace(/\.png$/i, '.email.jpg');
  try {
    execSync(
      `ffmpeg -y -i ${JSON.stringify(srcPngPath)} -vf "scale='min(${maxWidth},iw)':-2" -q:v ${quality} ${JSON.stringify(outPath)}`,
      { stdio: 'pipe' }
    );
    return outPath;
  } catch (e) {
    console.error('ffmpeg thumbnail failed for', srcPngPath, e.message);
    return null;
  }
}

function kanbanCardHtml(c) {
  const passBg = c.passed ? '#d9f2e3' : '#f6dfdf';
  const passFg = c.passed ? '#1c9d5c' : '#c23b3b';
  const img = c.cid
    ? `<tr><td style="padding:6px 6px 0"><img src="cid:${c.cid}" width="100%" alt="${c.title}" style="display:block;width:100%;height:auto;border-radius:5px;border:1px solid #eef1f6" /></td></tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;border:1px solid #d8dfe9;border-radius:8px;background:#ffffff">
    ${img}
    <tr><td style="padding:8px 10px 10px">
      <span style="display:inline-block;font:700 9.5px ui-monospace,'SF Mono',Consolas,monospace;background:${passBg};color:${passFg};padding:2px 6px;border-radius:4px;letter-spacing:.03em">${c.passed ? 'PASS' : 'FAIL'}</span>
      <span style="font:700 9.5px ui-monospace,'SF Mono',Consolas,monospace;color:#8b96ab;margin-left:5px">${c.id}</span>
      <div style="font:600 12.5px -apple-system,Arial,sans-serif;color:#0a1626;margin-top:4px">${c.title}</div>
      <div style="font:400 11px -apple-system,Arial,sans-serif;color:#55627a;margin-top:2px">${c.note || ''}</div>
    </td></tr>
  </table>`;
}

function kanbanColumnHtml(group) {
  return `<td valign="top" width="33.33%" class="kanban-col" style="padding:0 6px">
    <div style="font:700 11px ui-monospace,'SF Mono',Consolas,monospace;text-transform:uppercase;letter-spacing:.08em;color:#4a6b8f;border-bottom:1px solid #d8dfe9;padding-bottom:6px;margin:0 0 10px">${group.label} &middot; ${group.cases.length}</div>
    ${group.cases.map(kanbanCardHtml).join('\n')}
  </td>`;
}

/**
 * Builds a table-based (email-client-safe) kanban board: one column per
 * group, one card per test case, screenshot referenced via cid: (caller
 * must supply matching inline attachments - see sendKanbanReportEmail).
 */
function buildKanbanEmailHtml({ target, runAt, passCount, totalCount, groups, evidenceNote }) {
  const allPassed = passCount === totalCount;
  return `<style>
    @media (max-width: 480px) {
      .kanban-col { display:block !important; width:100% !important; padding:0 0 18px !important; }
    }
  </style>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:660px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #d8dfe9">
        <tr><td style="background:#0f2a4a;padding:22px 26px;border-bottom:3px solid #b5852c">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font:700 19px/1.3 -apple-system,Arial,sans-serif;color:#eef1f6">
              AMC Spark &mdash; Full-Site QA Report
              <div style="font:600 10.5px/1.6 ui-monospace,'SF Mono',Consolas,monospace;color:#e6c98a;letter-spacing:.07em;text-transform:uppercase;margin-top:4px">${target} &middot; ${runAt}</div>
            </td>
            <td align="right" style="font:700 32px/1 ui-monospace,'SF Mono',Consolas,monospace;color:${allPassed ? '#22e07a' : '#f0a34a'};white-space:nowrap">${passCount}/${totalCount}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:18px 20px 6px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${groups.map(kanbanColumnHtml).join('\n')}
          </tr></table>
        </td></tr>
        <tr><td style="padding:14px 26px 20px;background:#f6f8fb;font:400 11.5px/1.6 -apple-system,Arial,sans-serif;color:#55627a;border-top:1px solid #d8dfe9">
          ${evidenceNote || ''}
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

/**
 * Sends the kanban board as the email body, with each card's screenshot
 * embedded inline via CID and any extraAttachments (video, full zip)
 * attached normally alongside it.
 */
async function sendKanbanReportEmail({ apiKey, from, to, subject, target, runAt, passCount, totalCount, groups, extraAttachments = [] }) {
  if (!apiKey || !from || !to) {
    console.log('Email requested but QA_BREVO_API_KEY/QA_EMAIL_FROM/QA_EMAIL_TO not all set - skipping.');
    return;
  }

  const inlineAttachments = [];
  for (const group of groups) {
    for (const c of group.cases) {
      if (!c.screenshotPath) continue;
      const thumbPath = shrinkForEmail(c.screenshotPath);
      if (!thumbPath) continue;
      c.cid = path.basename(c.screenshotPath).replace(/\.png$/i, '.jpg');
      inlineAttachments.push({ name: c.cid, content: fs.readFileSync(thumbPath).toString('base64') });
    }
  }

  const evidenceNote = extraAttachments.length
    ? `${extraAttachments.map(f => path.basename(f)).join(' and ')} attached below. Screenshots above are compressed for email; full-resolution originals aren't attached here (they'd push most runs over Brevo's 20MB mail limit) but are saved alongside this run's zip. QA-generated Quick Quote / Contact / Project Desk submissions are tagged <b>[QA AUTOMATED TEST]</b> in the admin dashboard - safe to ignore or delete, there is no automated cleanup yet.`
    : 'QA-generated Quick Quote / Contact / Project Desk submissions are tagged <b>[QA AUTOMATED TEST]</b> in the admin dashboard - safe to ignore or delete, there is no automated cleanup yet.';

  const html = buildKanbanEmailHtml({ target, runAt, passCount, totalCount, groups, evidenceNote });
  const textFallback = groups.map(g => `${g.label}\n` + g.cases.map(c => `[${c.passed ? 'PASS' : 'FAIL'}] ${c.id} - ${c.title}`).join('\n')).join('\n\n');

  const attachment = [
    ...inlineAttachments,
    ...extraAttachments.map(f => ({ name: path.basename(f), content: fs.readFileSync(f).toString('base64') })),
  ];

  const payload = {
    sender: { name: 'AMC Spark QA', email: from },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: textFallback,
    attachment,
  };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log('Kanban email send status:', res.status, body);
}

module.exports = { createSession, zipRun, sendReportEmail, sendKanbanReportEmail, hasFfmpeg };
