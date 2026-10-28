// End-to-end test: real extension in headless Chromium, mock Outlook (via request routing)
// and mock journal sites on localhost. No real accounts or sites are touched.
//   node e2e.mjs <extension dir>          rules only (LLM off)
//   node e2e.mjs <extension dir> llm      Anthropic backend, with the Claude API mocked in the service worker
//   node e2e.mjs <extension dir> codex    Codex backend: real native host and real `codex exec`
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const EXT = process.argv[2];
const MODE = process.argv[3] || 'rules';
const LLM = MODE !== 'rules';
const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => serve(req, res, u, body));
});
function serve(req, res, u, body) {
  hits.push(req.method + ' ' + u.pathname + u.search + (body ? ' ' + body : ''));
  const html = (title, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>${title}</title><body>${body}</body>`); };
  const banner = `<div id="onetrust-consent-sdk"><button>Cookie settings</button><button>Accept all cookies</button></div>`;
  switch (u.pathname) {
    case '/track': res.writeHead(302, { location: '/em/Default' }); return res.end();
    case '/em/Default': return html('Decline Review', `Login | Register <iframe id="content" src="/em/decline?${u.search.slice(1)}"></iframe>${banner}`);
    case '/em/decline': return html('Decline Review', `<form name="declineForm" action="/em/decline2" method="post" onsubmit="return confirm('sure?')">
        Thank you for your time in considering this invitation. Click Submit to confirm that you are declining this invitation.
        <textarea name="reason"></textarea><input type="button" value="Cancel"><input type="submit" value="Submit"></form>`);
    case '/em/decline2': return html('Decline Review Confirmation', `Thank you. <a href="/">Login to Editorial Manager</a>`);
    // Modeled on IEEE Access's real page (Oct 2026): the confirm "button" is a plain link.
    case '/s1': return html('ScholarOne Manuscripts', `<a href="/login">Log In</a> Please Confirm Your Response
        To update the site's records, you must confirm your response from the email. Your Response: Declined
        <a href="javascript:history.back()">Cancel</a> <a href="/s1/done${u.search}">I Confirm This Response</a>`);
    case '/s1/done': return html('ScholarOne Manuscripts', `Please Suggest Replacements Thank you. Your response of "Declined" has been recorded.
        Please provide names of others who may be suitable. <input name="first1"> <input name="last1">
        <a class="btn">Decline</a> <a class="btn">Submit & Go to Log In Page</a>`);
    case '/odd': return html('Odd Journal', `<form action="/odd/done" method="post">Why are you declining?
        <select name="r" required><option value=""></option><option>Too busy</option></select><button>Submit</button></form>`);
    case '/odd/done': return html('Odd Journal', 'Your decline has been recorded.');
    case '/jpc': return html('JPC', `<form action="/jpc/done" method="post">Respond to the review request. <button>Decline</button></form>`);
    case '/jpc/done': return html('JPC', 'You have declined this review. Thanks.');
    default: return html('x', 'not found');
  }
}
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const ME = 'Doe, Jane (jd4x)';
const fmt = d => d.toLocaleString('en-US', { weekday: 'short', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/,/g, '');
const soon = fmt(new Date(Date.now() + 120000));
const emails = [
  { id: 'A/1=', sender: 'JoVE Review', addr: 'em@editorialmanager.com', subject: 'Invitation to Peer Review "Graph DP" for JoVE (JoVE1)', to: ME, unread: true,
    body: `Dear Dr. Doe, please click <a href="${BASE}/em/agree">Agree to Review</a> or <a href="${BASE}/track?i=1">Decline to Review</a>. <a href="${BASE}/em/remove">(Remove my information/details)</a>` },
  { id: 'B', sender: 'Transactions on Dependable and Secure Computing', addr: 'onbehalfof@manuscriptcentral.com', subject: 'TDSC-2026-10-9999 - Invitation to Review (Doe)', to: ME, cc: 'ae@example.edu', unread: true,
    body: `Dear Dr. Doe: *** Agreed: <a href="${BASE}/s1agree?URL_MASK=a1">${BASE}/s1agree</a>Declined: <a href="${BASE}/s1?URL_MASK=d1">${BASE}/s1</a>Unavailable: <a href="${BASE}/s1?URL_MASK=u1">${BASE}/s1</a>` },
  { id: 'C', sender: 'Transactions on Dependable and Secure Computing', addr: 'onbehalfof@manuscriptcentral.com', subject: 'TDSC-2026-10-9999 - Invitation to Review (Lee)', to: 'lee@example.org', cc: ME, unread: true,
    body: `Dear Dr. Lee: Agreed: <a href="${BASE}/s1x?URL_MASK=a2">x</a>Declined: <a href="${BASE}/s1x?URL_MASK=d2">x</a>` },
  { id: 'D', sender: 'JoVE Editorial Office', addr: 'em@editorialmanager.com', subject: 'JoVE Editorial Manager Registration', to: ME, unread: true, body: 'You have been registered.' },
  { id: 'E', sender: 'Student, A', addr: 'a@example.edu', subject: 'Can you review my project proposal?', to: ME, unread: true, body: 'Hi professor' },
  { id: 'F', sender: 'JoVE Review', addr: 'em@editorialmanager.com', subject: 'Invitation to Peer Review "Old" for JoVE (JoVE0)', to: ME, unread: false, when: 'Thu 10/01/2026 9:00 AM',
    body: `<a href="${BASE}/track?i=0">Decline to Review</a>` },
  { id: 'G', sender: 'Odd Journal', addr: 'ed@odd.org', subject: 'Invitation to review for Odd Journal', to: ME, unread: true, body: `<a href="${BASE}/odd">Decline to Review</a>` },
  ...(LLM ? [{ id: 'K', sender: 'Journal of Privacy and Confidentiality', addr: 'ojs@jpc.org', subject: 'Review request: Private Counting', to: ME, unread: true,
    body: `Dear Jane, would you review this? <a href="${BASE}/jpc/agree">I can review</a> <a href="${BASE}/jpc">I cannot review</a>` }] : []),
  { id: 'J', sender: 'Friend', addr: 'f@x.org', subject: 'Lunch on Friday', to: ME, unread: true, body: 'Lunch?' },
];
const later = [
  { id: 'H', sender: 'JoVE Review', addr: 'em@editorialmanager.com', subject: 'Thank you for responding to our peer review invitation (JoVE1)', to: ME, unread: true, body: 'Thank you.' },
  { id: 'I', sender: 'Transactions on Dependable and Secure Computing', addr: 'onbehalfof@manuscriptcentral.com', subject: 'Follow-up: Invitation to Review TDSC-2026-10-9999 (DECLINED)', to: ME, unread: true, body: 'Thank you for replying.' },
  { id: 'L', sender: 'IEEE Access', addr: 'onbehalfof@manuscriptcentral.com', subject: 'Follow-up: Invitation to Review for IEEE Access', to: ME, unread: true,
    body: 'Dear Dr. Doe: Thank you for replying to my invitation to review Access-2026-00000 for IEEE Access. It is unfortunate that you are unable to review this manuscript at this time.' },
];

const mockOutlook = `<!doctype html><title>Mail - ${ME} - Outlook</title><body><div role="listbox" id="list"></div><div id="pane"></div><script>
window.__opened = []; window.__deleted = []; window.__unread = [];
const data = {};
function addRow(e) {
  data[e.id] = e;
  const r = document.createElement('div');
  r.setAttribute('role', 'option'); r.dataset.convid = e.id;
  const label = () => (e.unread ? 'Unread ' : '') + e.sender + ' ' + e.subject + ' ' + e.when + ' ' + e.body.replace(/<[^>]+>/g, '').slice(0, 200);
  r.setAttribute('aria-label', label());
  r.innerHTML = '<span title="' + e.addr + '">' + e.sender + '</span><span title="' + e.when + '"></span><button class="rd"></button><button title="Delete"></button>';
  const rd = r.querySelector('.rd');
  const sync = () => { rd.title = e.unread ? 'Mark as read' : 'Mark as unread'; r.setAttribute('aria-label', label()); };
  sync();
  rd.onclick = ev => { ev.stopPropagation(); e.unread = !e.unread; if (e.unread) __unread.push(e.id); sync(); };
  r.querySelector('[title=Delete]').onclick = ev => { ev.stopPropagation(); __deleted.push(e.id); r.remove(); };
  r.onclick = () => {
    __opened.push(e.id); e.unread = false; sync();
    history.pushState({}, '', '/mail/inbox/id/' + encodeURIComponent(e.id));
    setTimeout(() => {
      const pane = document.getElementById('pane');
      pane.innerHTML = '<div aria-label="Email message" id="focused"><div class="hdr"></div><div><div><div aria-label="Message body">' + e.body + '</div></div></div></div>';
      // Like real Outlook's first open after loading (Oct 2026): body first, To and From lines later.
      const hdr = pane.querySelector('.hdr');
      setTimeout(() => hdr.insertAdjacentHTML('beforeend', '<div aria-label="To: ' + e.to + '"></div>' + (e.cc ? '<div aria-label="Cc: ' + e.cc + '"></div>' : '')), 80);
      setTimeout(() => hdr.insertAdjacentHTML('afterbegin', '<div aria-label="From: ' + e.sender + '"></div>'), 350);
    }, 200);
  };
  document.getElementById('list').prepend(r);
}
window.__addRow = addRow;
${JSON.stringify(emails)}.forEach(e => addRow({ when: ${JSON.stringify(soon)}, ...e }));
</script></body>`;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-'));
// Chromium looks for native-messaging hosts under its user data dir, so the real host can
// be registered for this throwaway profile only.
if (MODE === 'codex') execFileSync(path.join(EXT, 'host', 'install.sh'), [path.join(userDir, 'NativeMessagingHosts')]);
const context = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.route('https://outlook.cloud.microsoft/**', route => route.fulfill({ contentType: 'text/html', body: mockOutlook }));
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const llmCalls = [];
await worker.evaluate(llm => chrome.storage.local.set({ llm }), { rules: 'off', llm: 'anthropic', codex: 'codex' }[MODE]);
if (MODE === 'llm') {
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: 'test-key' }));
  await worker.evaluate(() => {
    self.__llmCalls = [];
    self.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const content = body.messages[0].content;
      let out;
      if (body.system.startsWith('You sort emails')) {
        out = /Journal of Privacy/.test(content)
          ? { category: 'review_invitation', addressed_to_user: true, decline_link: 1, note: 'JPC' }
          : { category: 'other', addressed_to_user: true, decline_link: -1, note: 'not a review invitation' };
      } else if (/Why are you declining/.test(content)) {
        const frame = +content.match(/Frame (\d+):[^\n]*\n[^\n]*Why are you declining/)[1];
        out = { status: 'act', note: 'pick reason, submit', actions: [
          { frame, element: +content.match(/\[(\d+)\] select/)[1], kind: 'select', value: 'Too busy' },
          { frame, element: +content.match(/\[(\d+)\] button[^\n]*"Submit"/)[1], kind: 'click', value: '' }] };
      } else if (/recorded/.test(content)) {
        out = { status: 'declined', actions: [], note: 'decline recorded' };
      } else out = { status: 'stuck', actions: [], note: 'unknown' };
      self.__llmCalls.push({ url: String(url), headers, body: { ...body, messages: undefined }, out });
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
  });
}
const page = await context.newPage();
await page.goto('https://outlook.cloud.microsoft/mail/');

const until = async (what, fn, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 500)); }
  console.log('TIMEOUT waiting for', what); return false;
};
await until('both declines submitted', () => hits.some(h => h.startsWith('POST /em/decline2')) && hits.some(h => h.startsWith('GET /s1/done')));
if (LLM) await until('odd + jpc declines', () => hits.some(h => h.startsWith('POST /odd/done')) && hits.some(h => h.startsWith('POST /jpc/done')), 180000);
else await until('odd journal tab to fail', async () => (await worker.evaluate(() => chrome.storage.local.get('log'))).log?.some(e => e.action.startsWith('failed')));
await new Promise(r => setTimeout(r, 3000));
const tabsAfterDecline = context.pages().map(p => p.url());
for (const e of later) await page.evaluate(([e, when]) => __addRow({ when, ...e }), [e, soon]);
// Declined invitations (A, B; G and K when the LLM handles them), the registration and the confirmations.
const DELETED = JSON.stringify(LLM ? ['A/1=', 'B', 'D', 'G', 'H', 'I', 'K', 'L'] : ['A/1=', 'B', 'D', 'H', 'I', 'L']);
await until('invitations and confirmations deleted', () => page.evaluate(n => __deleted.length >= n, JSON.parse(DELETED).length));
await new Promise(r => setTimeout(r, 4000));

const state = await page.evaluate(() => ({ opened: __opened, deleted: __deleted, unread: __unread }));
const { log } = await worker.evaluate(() => chrome.storage.local.get('log'));
const calls = MODE === 'llm' ? await worker.evaluate(() => self.__llmCalls) : [];
const checks = LLM ? {
  'rules still handle EM + ScholarOne': hits.some(h => h.startsWith('POST /em/decline2')) && hits.some(h => h.startsWith('GET /s1/done')),
  'LLM-classified JPC invitation declined via "I cannot review"': hits.some(h => h.startsWith('POST /jpc/done')) && !hits.some(h => h.includes('/jpc/agree')),
  'LLM filled the required reason on the odd page': hits.some(h => h.startsWith('POST /odd/done') && h.includes('Too+busy')),
  'all decline tabs closed': !context.pages().some(p => /127\.0\.0\.1/.test(p.url())),
  'cc copy still not declined': !hits.some(h => h.includes('/s1x')),
  'student email: LLM said other, back to unread': state.unread.includes('E') && log.some(e => e.action === 'ignored' && /project proposal/.test(e.subject)),
  'declined invitations, registration + 3 confirmations deleted, nothing else': JSON.stringify([...state.deleted].sort()) === DELETED,
  ...(MODE === 'llm' && { 'request shape (model, json_schema, effort, fallback beta, browser header)': calls.length > 0 && calls.every(c =>
    c.url.startsWith('https://api.anthropic.com/v1/messages') && c.body.model === 'claude-opus-5-5' && c.body.output_config?.format?.type === 'json_schema' &&
    c.body.output_config.effort === 'low' && c.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(c.headers['anthropic-beta'] || '') &&
    c.headers.authorization === 'Bearer test-key' && c.headers['anthropic-dangerous-direct-browser-access'] === 'true') }),
} : {
  'JoVE-style decline submitted': hits.some(h => h.startsWith('POST /em/decline2')),
  'ScholarOne decline submitted': hits.some(h => h.startsWith('GET /s1/done')),
  'used the Declined: link, not Unavailable': hits.some(h => h.includes('URL_MASK=d1')) && !hits.some(h => h.includes('URL_MASK=u1')),
  'never hit an agree/remove link': !hits.some(h => /agree|remove/.test(h)),
  'cc copy (Lee) not declined': !hits.some(h => h.includes('/s1x')),
  'old invitation not opened': !state.opened.includes('F') && !hits.some(h => h.includes('i=0')),
  'unrelated email not opened': !state.opened.includes('J'),
  'declined invitations, registration + 3 confirmations deleted, nothing else': JSON.stringify([...state.deleted].sort()) === DELETED,
  'student email put back to unread': state.unread.includes('E'),
  'declined tabs closed, odd tab left open': !tabsAfterDecline.some(u => /\/em\/|\/s1/.test(u)) && tabsAfterDecline.some(u => u.includes('/odd')),
  'odd page not submitted': !hits.some(h => h.includes('/odd/done')),
};
console.log(JSON.stringify(checks, null, 1));
console.log('state', JSON.stringify(state));
console.log('tabs', JSON.stringify(tabsAfterDecline));
console.log('log'); for (const e of [...log].reverse()) console.log(' ', e.action, '|', e.subject, '|', e.note);
console.log('hits', hits.join('  '));
if (LLM) console.log('llm answers', JSON.stringify(calls.map(c => c.out)));
await context.close();
server.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
