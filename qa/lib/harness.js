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

module.exports = { createSession, zipRun, sendReportEmail, hasFfmpeg };
