// Outlook Web side of Review Auto Decline. Finds review-related emails that arrived after
// the extension was installed, opens each one once, and lets the background worker decide
// what it is. Invitations addressed to you get declined there, and deleted here once the
// site confirms; registration and decline-confirmation emails are deleted here; anything
// else goes back to unread.
const TRIAGE = /review|referee|manuscript|registration|account created|declined/i;
const IDLE_MS = 30000;
const tries = {};
const declined = [];
let busy = false;
let lastInput = 0;

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'declined') { declined.push(msg.id); scan(); }
});
// Shows which version runs in this tab (for checking that a reload reached open tabs).
document.documentElement.dataset.reviewAutoDecline = chrome.runtime.getManifest().version;

for (const ev of ['mousedown', 'mousemove', 'keydown', 'wheel']) {
  addEventListener(ev, e => { if (e.isTrusted) lastInput = Date.now(); }, true);
}
const userActive = () => !document.hidden && Date.now() - lastInput < IDLE_MS;

// Resolves with test()'s first truthy value, re-checking on DOM changes. Waiting on
// mutations rather than polling timers keeps it fast when Chrome throttles a hidden tab.
function waitFor(test, ms = 15000) {
  return new Promise(resolve => {
    const done = v => { obs.disconnect(); clearTimeout(timer); resolve(v); };
    const obs = new MutationObserver(() => { const v = test(); if (v) done(v); });
    const timer = setTimeout(() => done(test()), ms);
    obs.observe(document.body, { childList: true, subtree: true });
    const v = test();
    if (v) done(v);
  });
}

const findRow = id => document.querySelector(`[role="option"][data-convid="${CSS.escape(id)}"]`);

function rowInfo(row) {
  const titles = [...row.querySelectorAll('[title]')].map(e => e.title);
  const when = titles.find(t => /\d{1,2}\/\d{1,2}\/\d{4}/.test(t));
  return {
    row,
    id: row.getAttribute('data-convid'),
    listLine: (row.getAttribute('aria-label') || '').replace(/\s+/g, ' '),
    sender: titles.find(t => t.includes('@')) || '',
    time: when ? Date.parse(when.replace(/^\w{3} /, '')) : NaN,
    unread: !!row.querySelector('[title="Mark as read"]'),
  };
}

const messageBody = () =>
  document.querySelector('#focused[aria-label="Email message"] [aria-label="Message body"]') ||
  document.querySelector('[aria-label="Message body"]');

// The head of the email plus the text around each link: enough to classify it and pick
// the decline link without sending a whole manuscript abstract to the LLM.
function excerpt(text) {
  const spans = [[0, 800], ...[...text.matchAll(/\[L\d+:/g)].map(m => [m.index - 200, m.index + 200])];
  let out = '';
  let end = 0;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    out += (a > end ? ' … ' : '') + text.slice(Math.max(a, end), b);
    end = b;
  }
  return out;
}

// Opens the row in the reading pane. Outlook renders a fresh body element per message,
// so waiting for a new one avoids reading whatever message was open before.
async function openEmail({ row, id }) {
  const opened = () => decodeURIComponent(location.pathname).endsWith('/' + id);
  const old = opened() ? null : messageBody();
  row.click();
  const body = await waitFor(() => { const b = opened() && messageBody(); return b && b !== old && b; });
  if (!body) return null;
  const msg = body.closest('[aria-label="Email message"]') || document;
  // On the first email after Outlook loads, the To and From lines appear a few hundred ms
  // after the body; reading them early made an invitation look like it wasn't sent to you.
  if (!await waitFor(() => msg.querySelector('[aria-label^="To:"]') && msg.querySelector('[aria-label^="From:"]'), 5000)) return null;
  const field = name => msg.querySelector(`[aria-label^="${name}:"]`)?.getAttribute('aria-label').slice(name.length + 1).trim() || '';

  const anchors = [...body.querySelectorAll('a[href]')].slice(0, 40);
  const copy = body.cloneNode(true);
  [...copy.querySelectorAll('a[href]')].slice(0, 40)
    .forEach((a, i) => a.replaceWith(`[L${i}: ${a.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)}]`));
  const text = copy.textContent.replace(/\s+/g, ' ').trim();
  const links = anchors.map((a, i) => {
    const at = text.indexOf(`[L${i}:`);
    const prev = text.lastIndexOf(']', at - 1);
    return { text: a.textContent.replace(/\s+/g, ' ').trim(), href: a.href, before: text.slice(Math.max(prev + 1, at - 60), at) };
  });
  return { from: field('From'), to: field('To'), cc: field('Cc'), text: excerpt(text), links };
}

async function scan() {
  const el = document.activeElement;
  if (busy || userActive() || el?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el?.tagName)) return;
  busy = true;
  try {
    for (const id of declined.splice(0)) findRow(id)?.querySelector('button[title="Delete"]')?.click();
    const { installedAt = Date.now(), seen = {} } = await chrome.storage.local.get(['installedAt', 'seen']);
    for (const k in seen) if (seen[k] < Date.now() - 30 * 864e5) delete seen[k];
    const me = (document.title.match(/ - (.+) - Outlook/) || [])[1];
    const rows = [...document.querySelectorAll('[role="option"][data-convid]')].map(rowInfo);
    for (const info of rows) {
      const key = info.id + '|' + info.time;
      if (!(info.time >= installedAt) || seen[key] || (tries[key] || 0) >= 3 || !TRIAGE.test(info.listLine)) continue;
      if (userActive()) break;
      tries[key] = (tries[key] || 0) + 1;
      const email = await openEmail(info);
      if (!email) continue;
      const verdict = await chrome.runtime.sendMessage({
        type: 'classify', me, email: { ...email, id: info.id, listLine: info.listLine, sender: info.sender },
      });
      if (verdict?.action !== 'retry') {
        seen[key] = Date.now();
        await chrome.storage.local.set({ seen });
      }
      const row = findRow(info.id);
      if (verdict?.action === 'delete') row?.querySelector('button[title="Delete"]')?.click();
      else if (verdict?.action !== 'declining' && info.unread) row?.querySelector('[title="Mark as unread"]')?.click();
    }
  } finally {
    busy = false;
  }
}

let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  setTimeout(() => { queued = false; scan(); }, 3000);
}).observe(document.body, { childList: true, subtree: true });
setInterval(scan, 60000);
scan();
