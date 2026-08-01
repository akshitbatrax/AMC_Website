/**
 * QA test: exercises the major user-facing scenarios across the whole AMC
 * Spark website in one run - the homepage's three lead-gen forms (Quick
 * Quote, Contact, Project Desk), the Office Use Only admin login journey
 * (dashboard tabs, invoice generator, logout, a rejected bad password), and
 * mobile layout sanity (no horizontal overflow) on the two most complex
 * pages. Captures a timestamped, URL-stamped screenshot at every step,
 * records a real-time video of the desktop journey, and can email the
 * whole run (report + screenshots + video, zipped).
 *
 * Test submissions this script creates (Quick Quote / Contact / Project
 * Desk) are tagged "[QA AUTOMATED TEST]" in their message/notes field so
 * they're easy to spot in the admin dashboard - there is no API to delete
 * tickets, so these will sit there as real entries until removed by hand.
 *
 * Nothing here is deployed anywhere - it's a standalone script you run
 * against a live site from your own machine (or a CI runner). It does not
 * touch the repo's app code.
 *
 * Requires (env vars, never hardcode these):
 *   QA_ADMIN_USER      - real admin username
 *   QA_ADMIN_PASS      - real admin password
 * Optional (same names as admin_login_test.js):
 *   QA_BASE_URL         (default https://www.amcspark.com)
 *   QA_CDP_PORT         (default 9222) - a headless Chrome must already be
 *                        running with --remote-debugging-port on this port.
 *   QA_OUT_DIR          (default ./qa-run-<timestamp> next to this script)
 *   QA_RECORD_VIDEO     "0" to skip video recording (default "1"). Needs
 *                        ffmpeg on PATH.
 *   QA_SEND_EMAIL       "1" to email the report (needs QA_BREVO_API_KEY,
 *                        QA_EMAIL_FROM, QA_EMAIL_TO)
 *   QA_BREVO_API_KEY, QA_EMAIL_FROM, QA_EMAIL_TO
 *
 * Run: node qa/full_site_test.js
 */

const fs = require('fs');
const path = require('path');
const { createSession, zipRun, sendKanbanReportEmail } = require('./lib/harness');

// Maps each test case to the email report's kanban column and the
// screenshot that best represents it - kept separate from the live
// pass/fail results below so a card always renders even if a step throws
// partway through.
const CASE_META = [
  { id: 'TC1', group: 'Public site', title: 'Homepage loads', screenshot: '01-homepage.png' },
  { id: 'TC2', group: 'Public site', title: 'Quick Quote modal opens', screenshot: '02-quick-quote-modal.png' },
  { id: 'TC3', group: 'Public site', title: 'Quick Quote validates', screenshot: '03-quick-quote-validation.png' },
  { id: 'TC4', group: 'Public site', title: 'Quick Quote submits', screenshot: '04-quick-quote-success.png' },
  { id: 'TC5', group: 'Public site', title: 'Contact form validates', screenshot: '05-contact-filled.png' },
  { id: 'TC6', group: 'Public site', title: 'Contact form submits', screenshot: '06-contact-success.png' },
  { id: 'TC7', group: 'Public site', title: 'Project Desk submits', screenshot: '08-project-desk-success.png' },
  { id: 'TC8', group: 'Admin & login', title: 'Office Use Only gate', screenshot: '09-login-page.png' },
  { id: 'TC9', group: 'Admin & login', title: 'Valid login succeeds', screenshot: '10-login-success-dashboard.png' },
  { id: 'TC10', group: 'Admin & login', title: 'Dashboard tabs switch', screenshot: '11-dashboard-tabs.png' },
  { id: 'TC11', group: 'Admin & login', title: 'Invoice Generator loads', screenshot: '12-invoice-generator.png' },
  { id: 'TC12', group: 'Admin & login', title: 'Logout ends the session', screenshot: '13-after-logout.png' },
  { id: 'TC13', group: 'Admin & login', title: 'Bad password rejected', screenshot: '14-wrong-password-rejected.png' },
  { id: 'TC14', group: 'Admin & login', title: 'Correct password still works', screenshot: '15-correct-password-reconfirmed.png' },
  { id: 'TC15', group: 'Mobile layout', title: 'Homepage fits mobile width', screenshot: '16-mobile-homepage.png' },
  { id: 'TC16', group: 'Mobile layout', title: 'Invoice Generator fits mobile width', screenshot: '17-mobile-invoice-generator.png' },
];

function buildEmailGroups(results, outDir) {
  const byId = Object.fromEntries(results.map(r => [r.id, r]));
  const order = [];
  const grouped = {};
  for (const meta of CASE_META) {
    const r = byId[meta.id];
    if (!r) continue;
    if (!grouped[meta.group]) { grouped[meta.group] = []; order.push(meta.group); }
    grouped[meta.group].push({
      id: meta.id,
      title: meta.title,
      note: r.note,
      passed: r.passed,
      screenshotPath: path.join(outDir, meta.screenshot),
    });
  }
  return order.map(label => ({ label, cases: grouped[label] }));
}

const BASE_URL     = process.env.QA_BASE_URL || 'https://www.amcspark.com';
const CDP_PORT     = process.env.QA_CDP_PORT || '9222';
const ADMIN_USER   = process.env.QA_ADMIN_USER;
const ADMIN_PASS   = process.env.QA_ADMIN_PASS;
const WRONG_PASS   = 'Wr0ng-Test-Password!Not-Real';
const OUT_DIR      = process.env.QA_OUT_DIR || path.join(__dirname, 'qa-run-' + new Date().toISOString().replace(/[:.]/g, '-'));
const RECORD_VIDEO = (process.env.QA_RECORD_VIDEO || '1') === '1';

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('QA_ADMIN_USER and QA_ADMIN_PASS must be set in the environment (never hardcode credentials in this file).');
  process.exit(1);
}

const QA_TAG = '[QA AUTOMATED TEST - safe to ignore/delete]';
const LEAD = {
  name: 'QA Test Bot',
  email: process.env.QA_EMAIL_TO || 'qa-test@amcspark.com',
  phone: '+91 9220533011',
};

const results = [];
function record(id, name, passed, note) {
  results.push({ id, name, passed: !!passed, note: note || '' });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${id} - ${name}${note ? ' :: ' + note : ''}`);
}

async function main() {
  // ================= Desktop pass (video recorded) =================
  const desktop = await createSession({ cdpPort: CDP_PORT, outDir: OUT_DIR, recordVideo: RECORD_VIDEO, width: 1280, height: 900 });
  const { goto, ev, shot, waitFor } = desktop;
  const terminal = (elId) => `(function(){var t=document.getElementById('${elId}').textContent; return /thank you|submitted|received|sent|could not/i.test(t) ? t : null;})()`;

  // ---- TC1: homepage loads with key sections present ----
  await goto(BASE_URL + '/');
  const homeOk = await ev(`!!(document.querySelector('.header') && document.querySelector('#contact') && document.querySelector('.footer'))`);
  record('TC1', 'Homepage loads with nav, contact section and footer present', homeOk);
  await shot('01-homepage');

  // ---- TC2: Quick Quote modal opens ----
  await ev(`document.getElementById('openQuote').click()`);
  await new Promise(r => setTimeout(r, 400));
  const modalOpen = await ev(`document.getElementById('quoteModal').classList.contains('show')`);
  record('TC2', 'Quick Quote modal opens', modalOpen);
  await shot('02-quick-quote-modal');

  // ---- TC3: Quick Quote validation blocks incomplete submission ----
  await ev(`document.getElementById('qqForm').requestSubmit()`);
  await new Promise(r => setTimeout(r, 400));
  let statusText = await ev(`document.getElementById('qqStatus').textContent`);
  record('TC3', 'Quick Quote blocks submission with required fields empty', /please complete/i.test(statusText || ''),
    'status text: ' + statusText);
  await shot('03-quick-quote-validation');

  // ---- TC4: Quick Quote valid submission succeeds ----
  await ev(`
    document.getElementById('qqName').value = ${JSON.stringify(LEAD.name)};
    document.getElementById('qqEmail').value = ${JSON.stringify(LEAD.email)};
    document.getElementById('qqPhone').value = ${JSON.stringify(LEAD.phone)};
    document.getElementById('qqType').value = 'AMC / O&M';
    document.getElementById('qqNotes').value = ${JSON.stringify(QA_TAG + ' Quick Quote submission.')};
  `);
  await ev(`document.getElementById('qqForm').requestSubmit()`);
  statusText = await waitFor(terminal('qqStatus'));
  record('TC4', 'Quick Quote submits successfully with valid data', /thank you|submitted/i.test(statusText || ''),
    'status text: ' + statusText);
  await shot('04-quick-quote-success');
  await ev(`document.getElementById('closeQuote').click()`);

  // ---- TC5: Contact form validation blocks incomplete submission ----
  await ev(`document.getElementById('contactForm').requestSubmit()`);
  await new Promise(r => setTimeout(r, 400));
  statusText = await ev(`document.getElementById('contactStatus').textContent`);
  record('TC5', 'Contact form blocks submission with required fields empty', /please fill/i.test(statusText || ''),
    'status text: ' + statusText);

  // ---- TC6: Contact form valid submission succeeds ----
  await ev(`
    document.getElementById('cname').value = ${JSON.stringify(LEAD.name)};
    document.getElementById('cemail').value = ${JSON.stringify(LEAD.email)};
    document.getElementById('cmsg').value = ${JSON.stringify(QA_TAG + ' Contact form submission.')};
  `);
  await shot('05-contact-filled');
  await ev(`document.getElementById('contactForm').requestSubmit()`);
  statusText = await waitFor(terminal('contactStatus'));
  record('TC6', 'Contact form submits successfully with valid data', /sent/i.test(statusText || ''),
    'status text: ' + statusText);
  await shot('06-contact-success');

  // ---- TC7: Project Desk valid submission succeeds ----
  await ev(`
    document.getElementById('org').value = 'QA Test Org';
    document.getElementById('name').value = ${JSON.stringify(LEAD.name)};
    document.getElementById('email').value = ${JSON.stringify(LEAD.email)};
    document.getElementById('phone').value = ${JSON.stringify(LEAD.phone)};
    document.getElementById('location').value = 'QA Test Site';
    document.getElementById('ptype').value = 'AMC / O&M';
    document.getElementById('notes').value = ${JSON.stringify(QA_TAG + ' Project Desk submission.')};
  `);
  await shot('07-project-desk-filled');
  await ev(`document.getElementById('projForm').requestSubmit()`);
  statusText = await waitFor(terminal('projStatus'));
  record('TC7', 'Project Desk submits successfully with valid data', /received|submitted/i.test(statusText || ''),
    'status text: ' + statusText);
  await shot('08-project-desk-success');

  // ---- TC8: Office Use Only link leads to the admin login page ----
  await goto(BASE_URL + '/');
  const officeLink = await ev(`(function(){
    const a = Array.from(document.querySelectorAll('a')).find(x => /office use only/i.test(x.textContent));
    return a ? a.getAttribute('href') : null;
  })()`);
  const destination = officeLink ? new URL(officeLink, BASE_URL + '/').href : null;
  await goto(destination || (BASE_URL + '/invoice-generator.html'));
  const onLoginPage = await ev(`!!(document.getElementById('user') && document.getElementById('pass') && document.querySelector('form'))`);
  record('TC8', 'Office Use Only link leads to the admin login page (auth required)', !!officeLink && !!onLoginPage,
    officeLink ? `link -> ${destination}` : 'Office Use Only link not found on homepage');
  await shot('09-login-page');

  // ---- TC9: valid credentials log in successfully ----
  await ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
             document.getElementById('pass').value = ${JSON.stringify(ADMIN_PASS)};
             document.querySelector('form').submit();`);
  let onDashboard = await waitFor(`(location.pathname === '/admin' && !!document.querySelector('.side, .dash')) || null`, { timeoutMs: 8000 });
  record('TC9', 'Valid credentials log in successfully', !!onDashboard, 'landed on ' + await ev('location.pathname'));
  await shot('10-login-success-dashboard');

  // ---- TC10: dashboard tabs switch correctly ----
  // Each tab click is polled rather than checked once: on a slower response
  // from Render's free tier, admin.js's own initial data fetch can still be
  // settling right after login, and a single immediate check can catch a
  // tab mid-transition rather than reflect a real failure.
  let tabsOk = true, tabsNote = '';
  for (const t of ['overview', 'kanban', 'table', 'analytics']) {
    const shown = await waitFor(`(function(){
      const btn = document.querySelector('[data-tab="${t}"]');
      if (!btn) return null;
      btn.click();
      const panel = document.getElementById('tab-${t}');
      return (panel && panel.classList.contains('show')) ? true : null;
    })()`, { timeoutMs: 6000 });
    if (!shown) { tabsOk = false; tabsNote = `${t} tab never showed within 6s`; break; }
  }
  if (tabsOk) await ev(`document.querySelector('[data-tab="overview"]').click()`);
  record('TC10', 'Admin dashboard tabs (Overview/Kanban/Table/Analytics) all switch correctly', tabsOk, tabsNote);
  await shot('11-dashboard-tabs');

  // ---- TC11: Invoice Generator loads after login ----
  await goto(BASE_URL + '/invoice-generator.html');
  const invoiceOk = await ev(`!!document.getElementById('pdfBtn')`);
  record('TC11', 'Invoice Generator page loads after login', invoiceOk, 'path: ' + await ev('location.pathname'));
  await shot('12-invoice-generator');

  // ---- TC12: logout ends the session ----
  await goto(BASE_URL + '/admin');
  const loggedOut = await ev(`(function(){
    const a = Array.from(document.querySelectorAll('a')).find(x => /log ?out/i.test(x.textContent));
    if (a) { location.href = a.href; return true; }
    return false;
  })()`);
  await waitFor(`(location.pathname === '/admin/login') || null`, { timeoutMs: 8000 });
  await goto(BASE_URL + '/admin');
  const sessionEnded = await ev(`location.pathname === '/admin/login'`);
  record('TC12', 'Logout ends the session (direct /admin access now redirects to login)', !!loggedOut && !!sessionEnded,
    'logout link clicked: ' + loggedOut + ', post-logout /admin -> ' + await ev('location.pathname'));
  await shot('13-after-logout');

  // ---- TC13: incorrect password is rejected (with error banner) ----
  await ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
             document.getElementById('pass').value = ${JSON.stringify(WRONG_PASS)};
             document.querySelector('form').submit();`);
  await waitFor(`(location.pathname === '/admin/login' && !!document.querySelector('.login-error')) || null`, { timeoutMs: 8000 });
  const rejectedCorrectly = await ev(`location.pathname === '/admin/login'`);
  const errorShown = await ev(`!!document.querySelector('.login-error')`);
  record('TC13', 'Incorrect password is rejected and shows an error banner', !!rejectedCorrectly && !!errorShown,
    'landed on ' + await ev('location.pathname') + ', error banner present: ' + errorShown);
  await shot('14-wrong-password-rejected');

  // ---- TC14: correct password still works after a failed attempt ----
  await ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
             document.getElementById('pass').value = ${JSON.stringify(ADMIN_PASS)};
             document.querySelector('form').submit();`);
  onDashboard = await waitFor(`(location.pathname === '/admin' && !!document.querySelector('.side, .dash')) || null`, { timeoutMs: 8000 });
  record('TC14', 'Only the correct password is ever accepted (re-confirmed after a bad attempt)', !!onDashboard,
    'landed on ' + await ev('location.pathname'));
  await shot('15-correct-password-reconfirmed');

  const { videoPath, frameCount } = await desktop.finish();

  // ================= Mobile pass (screenshots only, no video) =================
  const mobile = await createSession({ cdpPort: CDP_PORT, outDir: OUT_DIR, recordVideo: false, width: 390, height: 844, mobile: true });

  await mobile.goto(BASE_URL + '/');
  const homeMobileOk = await mobile.noHorizontalOverflow();
  record('TC15', 'Homepage has no horizontal overflow at 390px (mobile) width', homeMobileOk);
  await mobile.shot('16-mobile-homepage');

  // This CDP session reuses the same browser tab as the desktop pass, so
  // its cookies (including the TC14 login) usually carry over - but don't
  // rely on that: check whether we're already on the authenticated app
  // before assuming we need to log in again.
  await mobile.goto(BASE_URL + '/invoice-generator.html');
  const alreadyAuthed = await mobile.ev(`!!document.getElementById('pdfBtn')`);
  if (!alreadyAuthed) {
    await mobile.ev(`document.getElementById('user').value = ${JSON.stringify(ADMIN_USER)};
                      document.getElementById('pass').value = ${JSON.stringify(ADMIN_PASS)};
                      document.querySelector('form').submit();`);
    await new Promise(r => setTimeout(r, 1000));
    await mobile.goto(BASE_URL + '/invoice-generator.html');
  }
  const invoiceMobileOk = await mobile.noHorizontalOverflow();
  record('TC16', 'Invoice Generator has no horizontal overflow at 390px (mobile) width', invoiceMobileOk);
  await mobile.shot('17-mobile-invoice-generator');
  await mobile.finish();

  // ================= report =================
  const passCount = results.filter(r => r.passed).length;
  const summary = `AMC Spark - Full Site QA Report
Run at: ${new Date().toISOString()}
Target: ${BASE_URL}
Video: ${videoPath ? 'included (' + frameCount + ' frames, desktop journey only)' : (RECORD_VIDEO ? 'skipped - ffmpeg not found' : 'skipped (QA_RECORD_VIDEO=0)')}
Note: QA-generated test submissions (Quick Quote / Contact / Project Desk) are tagged "${QA_TAG}" - there is no automated cleanup, please disregard or delete them by hand in the admin dashboard.

Result: ${passCount}/${results.length} test cases passed

${results.map(r => `[${r.passed ? 'PASS' : 'FAIL'}] ${r.id} - ${r.name}${r.note ? '\n       ' + r.note : ''}`).join('\n')}
`;
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), summary);
  console.log('\n' + summary);

  const zipPath = zipRun(OUT_DIR, videoPath ? [videoPath] : []);

  if (process.env.QA_SEND_EMAIL === '1') {
    await sendKanbanReportEmail({
      apiKey: process.env.QA_BREVO_API_KEY,
      from: process.env.QA_EMAIL_FROM,
      to: process.env.QA_EMAIL_TO,
      subject: `AMC Spark Full Site QA Report - ${passCount}/${results.length} passed`,
      target: BASE_URL,
      runAt: new Date().toISOString(),
      passCount,
      totalCount: results.length,
      groups: buildEmailGroups(results, OUT_DIR),
      // The full zip (all full-resolution screenshots, ~12MB+ before
      // base64) pushed the message past Brevo's 20MB cap - every
      // screenshot is already embedded inline above at email-safe size,
      // so only the small text report and the video ride along here.
      // The zip itself is still produced on disk (and in the CI artifact
      // for the GitHub Actions path) for anyone who wants full-res originals.
      extraAttachments: [path.join(OUT_DIR, 'report.txt'), ...(videoPath ? [videoPath] : [])],
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
