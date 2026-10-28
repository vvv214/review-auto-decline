// Decides what each email from outlook.js is (rules first, then the LLM), and drives the
// decline page of every invitation it declines in a background tab until the site confirms.
import * as rules from './rules.js';
import * as llm from './llm.js';

const MAX_STEPS = 6;
const timers = {};
let logQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'update') {
    // After a reload or update, Chrome leaves open Outlook tabs with the old, disconnected script.
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().content_scripts[0].matches });
    for (const t of tabs) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['outlook.js'] }).catch(() => {});
  }
  if (reason !== 'install') return;
  chrome.storage.local.set({ installedAt: Date.now() });
  chrome.runtime.openOptionsPage();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

function log(entry) {
  logQueue = logQueue.then(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    await chrome.storage.local.set({ log: [{ t: Date.now(), ...entry }, ...log].slice(0, 200) });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'classify') return;
  decide(msg.email, msg.me, sender.tab.id).then(sendResponse, err => {
    log({ action: 'error', subject: msg.email.listLine.slice(0, 120), note: String(err) });
    sendResponse({ action: 'retry' });
  });
  return true;
});

async function decide(email, titleName, outlookTab) {
  const { myAddresses = '' } = await chrome.storage.local.get('myAddresses');
  const me = [titleName, ...myAddresses.split(',')].map(s => s?.trim()).filter(Boolean);
  const toMe = me.some(name => email.to.toLowerCase().includes(name.toLowerCase()));
  const subject = email.listLine.replace(/^((Unread|Pinned|Collapsed|Flagged) )+/, '').slice(0, 120);

  let verdict = rules.classifyEmail(email);
  let by = 'rules';
  if (!verdict) {
    const model = await llm.backend();
    if (!model) return { action: 'none' };
    verdict = await llm.classifyEmail(model, email, me);
    by = model.name;
    if (verdict.category === 'review_invitation' && !verdict.addressed_to_user) verdict.category = 'other';
  }
  const note = `${verdict.category} (${by})${verdict.note ? ': ' + verdict.note : ''}`;

  if (verdict.category === 'review_invitation') {
    const link = email.links[verdict.decline_link];
    const problem = !toMe ? 'not addressed to you (a copy you are cc\'d on?)'
      : !link || rules.NEVER.test(link.text) || /agreed?:\s*$/i.test(link.before) ? 'no safe decline link' : null;
    if (problem) {
      log({ action: 'skipped', subject, note: `${problem}; ${note}` });
      return { action: 'none' };
    }
    await startDecline(link.href, subject, { tab: outlookTab, id: email.id });
    log({ action: 'declining', subject, note });
    return { action: 'declining' };
  }
  if ((verdict.category === 'registration' || verdict.category === 'decline_confirmation') && toMe) {
    log({ action: 'deleted', subject, note });
    return { action: 'delete' };
  }
  if (by !== 'rules') log({ action: 'ignored', subject, note });
  return { action: 'none' };
}

// --- Decline tabs -------------------------------------------------------------------------

const jobKey = tabId => 'job' + tabId;
const getJob = async tabId => (await chrome.storage.session.get(jobKey(tabId)))[jobKey(tabId)];

// mail: the Outlook tab and conversation id of the invitation, deleted once the decline is done.
async function startDecline(url, subject, mail) {
  const tab = await chrome.tabs.create({ url, active: false });
  await chrome.storage.session.set({ [jobKey(tab.id)]: { subject, mail, steps: 0 } });
  schedule(tab.id, 5000);
}

function schedule(tabId, ms = 1500) {
  clearTimeout(timers[tabId]);
  timers[tabId] = setTimeout(() => step(tabId).catch(err => fail(tabId, String(err))), ms);
}

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  if (!(await getJob(tabId))) return;
  chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] }, world: 'MAIN', injectImmediately: true, func: acceptDialogs,
  }).catch(() => {});
});
chrome.webNavigation.onCompleted.addListener(async ({ tabId }) => {
  if (await getJob(tabId)) schedule(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(jobKey(tabId)));

async function step(tabId) {
  const job = await getJob(tabId);
  if (!job) return;
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: snapshot });
  const frames = results.filter(r => r.result).map(r => ({ frameId: r.frameId, ...r.result }));
  const sig = hash(frames.map(f => f.url + f.text).join('|'));

  // Rules get one try per page; if the page didn't change after their click, ask the LLM.
  let plan = sig === job.lastSig ? null : rules.declineStep(frames);
  if (!plan) {
    const model = await llm.backend();
    plan = model ? await llm.planDeclineStep(model, frames) : { status: 'stuck', note: 'page not recognized and the LLM is turned off' };
  }

  if (plan.status === 'declined' || plan.status === 'already') {
    log({ action: plan.status === 'declined' ? 'declined' : 'already closed', subject: job.subject, note: plan.note });
    // Only a decline we just made deletes the invitation: "already" may mean you accepted it.
    if (plan.status === 'declined') chrome.tabs.sendMessage(job.mail.tab, { type: 'declined', id: job.mail.id }).catch(() => {});
    await chrome.storage.session.remove(jobKey(tabId));
    return chrome.tabs.remove(tabId);
  }
  if (plan.status !== 'act' || !plan.actions.length) return fail(tabId, plan.note);
  if (job.steps >= MAX_STEPS) return fail(tabId, 'gave up after ' + MAX_STEPS + ' steps');
  const unsafe = plan.actions.find(a => {
    const el = frames.find(f => f.frameId === a.frame)?.els[a.element];
    return !el || rules.NEVER.test(el.label) || (a.kind !== 'click' && el.type === 'password');
  });
  if (unsafe) return fail(tabId, 'refused an unsafe action: ' + JSON.stringify(unsafe));

  await chrome.storage.session.set({ [jobKey(tabId)]: { ...job, steps: job.steps + 1, lastSig: sig } });
  // Typed text is always the fixed reason, so page text can't steer the LLM into typing
  // anything else (such as data from your machine) into a form.
  for (const a of plan.actions) {
    const value = a.kind === 'fill' ? llm.REASON : a.value;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [a.frame] }, func: act, args: [a.element, a.kind, value] });
  }
  schedule(tabId, 5000); // for actions that don't navigate
}

async function fail(tabId, note) {
  const job = await getJob(tabId);
  await chrome.storage.session.remove(jobKey(tabId));
  log({ action: 'failed (tab left open)', subject: job?.subject, note });
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return h;
}

// --- Injected into decline tabs (must be self-contained) --------------------------------

function acceptDialogs() {
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = (msg, value) => value ?? '';
}

function snapshot() {
  const shown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const els = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]')]
    .filter(e => e.type !== 'hidden' && shown(e) && !e.closest('#onetrust-consent-sdk'))
    .slice(0, 80);
  return {
    url: location.origin + location.pathname,
    title: document.title,
    text: clean(document.body?.innerText).slice(0, 3000),
    els: els.map((e, i) => {
      e.dataset.radIndex = i;
      const label = clean(e.labels?.[0]?.innerText || e.innerText || e.value || e.getAttribute('aria-label') || e.title || e.name).slice(0, 80);
      return {
        i, label,
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type') || (e.tagName === 'BUTTON' ? 'submit' : ''),
        ...(e.tagName === 'SELECT' && { options: [...e.options].map(o => clean(o.text)).slice(0, 20) }),
        ...(/^(checkbox|radio)$/.test(e.type) && { checked: e.checked }),
        ...(e.required && !e.value && { missing: true }),
      };
    }),
  };
}

function act(i, kind, value) {
  const e = document.querySelector(`[data-rad-index="${i}"]`);
  if (!e) return;
  if (kind === 'fill') {
    e.focus();
    e.value = value;
  } else if (kind === 'select') {
    const option = [...e.options].find(o => o.text.trim() === value);
    if (option) e.value = option.value;
  } else {
    return e.click();
  }
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
}
