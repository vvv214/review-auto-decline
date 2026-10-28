import { backend, classifyEmail } from './llm.js';

const fields = ['llm', 'codexModel', 'apiKey', 'model', 'myAddresses'];

chrome.storage.local.get([...fields, 'log']).then(store => {
  for (const f of fields) if (store[f]) document.getElementById(f).value = store[f];
  renderLog(store.log || []);
});
chrome.action.setBadgeText({ text: '' });

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set(Object.fromEntries(fields.map(f => [f, document.getElementById(f).value.trim()])));
  document.getElementById('saved').textContent = 'Saved';
});

// A made-up invitation in the ScholarOne format; the right answer is review_invitation via link L1.
const SAMPLE = {
  listLine: 'IEEE Access Invitation to Review for IEEE Access Access-2026-00000 Dear Dr. Doe: The manuscript entitled "Private Counting" has been submitted',
  sender: 'onbehalfof@manuscriptcentral.com', from: 'IEEE Access', to: 'Doe, Jane', cc: '',
  text: 'Dear Dr. Doe: The manuscript entitled "Private Counting" has been submitted to IEEE Access. Since your expertise is relevant, '
    + 'we would be grateful if you would consider reviewing it. *** PLEASE NOTE: This is a two-step process. *** '
    + 'Agreed: [L0: https://mc.manuscriptcentral.com/ieee-access?URL_MASK=a1] Declined: [L1: https://mc.manuscriptcentral.com/ieee-access?URL_MASK=d1]',
};

document.getElementById('test').addEventListener('click', async () => {
  const out = document.getElementById('tested');
  out.className = '';
  const llm = await backend();
  if (!llm) return void (out.textContent = 'LLM is off (or the Anthropic API key is missing); save a choice first');
  out.textContent = `Asking ${llm.name}…`;
  const start = Date.now();
  try {
    const v = await classifyEmail(llm, SAMPLE, ['Doe, Jane']);
    const ok = v.category === 'review_invitation' && v.decline_link === 1;
    out.className = ok ? 'pass' : 'fail';
    out.textContent = `${ok ? 'Works' : 'Unexpected answer'} (${llm.name}, ${((Date.now() - start) / 1000).toFixed(1)} s): ${v.category}, decline link L${v.decline_link}`;
  } catch (e) {
    out.className = 'fail';
    out.textContent = `Failed (${llm.name}): ${e.message}`;
  }
});

// options.html#test runs the test on open, for checking the install without clicking.
if (location.hash === '#test') document.getElementById('test').click();
// options.html#reload reloads the extension after a code change, like its button in chrome://extensions.
if (location.hash === '#reload') chrome.runtime.reload();

chrome.storage.onChanged.addListener(changes => {
  if (changes.log) renderLog(changes.log.newValue || []);
});

function renderLog(log) {
  const tbody = document.getElementById('log');
  tbody.replaceChildren(...log.map(e => {
    const tr = document.createElement('tr');
    for (const text of [new Date(e.t).toLocaleString(), e.action, e.subject || '', e.note || '']) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));
}
