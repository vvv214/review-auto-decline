// The two questions the extension asks an LLM when the rules in rules.js don't recognize
// something: what an email is, and what to do next on a review system's decline page.
// The LLM is either local Codex (`codex exec` through the native host in host/) or Claude.
import Anthropic from './lib/anthropic.mjs';

export const REASON = 'I am unable to review this manuscript at this time.';
const HOST = 'local.review_auto_decline';

const EMAIL_SYSTEM = `You sort emails for a professor who has decided to decline every journal peer-review invitation sent to them. Classify the email:
- review_invitation: a journal or its editor invites the user to review a manuscript (a first invitation or a reminder), and the email contains a link for declining.
- registration: an automated message saying an account was created or registered for the user on a manuscript submission or peer-review system such as Editorial Manager or ScholarOne.
- decline_confirmation: an automated message confirming that the user declined a review invitation, or thanking them for their response to one they declined.
- other: everything else, including conference program-committee invitations, reviews of the user's own submissions, review assignments the user already accepted, confirmations of agreeing to review, copies of invitations sent to other reviewers where the user is only copied as an editor, and anything you are unsure about.
Set addressed_to_user to true only when the user is the person invited: they are in the To line and the greeting names them.
Set decline_link to the number n of the [Ln] link that declines the invitation (labels like "Decline", "Declined:", "Unable to review"; prefer a plain decline over "Unavailable"), or -1 if there is none. Never pick a link that agrees, accepts, or removes the user's information.`;

const EMAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'addressed_to_user', 'decline_link', 'note'],
  properties: {
    category: { type: 'string', enum: ['review_invitation', 'registration', 'decline_confirmation', 'other'] },
    addressed_to_user: { type: 'boolean' },
    decline_link: { type: 'integer' },
    note: { type: 'string', description: 'A few words: journal name and why.' },
  },
};

const STEP_SYSTEM = `You operate a journal peer-review website in a browser tab for a user who has decided to DECLINE the review invitation that opened this tab. You get the visible text and the interactive elements of each frame. Choose the status:
- declined: the page confirms the decline is done.
- already: the invitation was already answered, has expired, or was withdrawn.
- act: list the actions that move the decline forward, ending with the click that submits it. If a reason is required, choose the option closest to lack of time, or fill the text box (the extension always types "${REASON}"). Leave optional fields such as suggested reviewers empty.
- stuck: anything else, for example the page wants a login or a password.
Never click anything that agrees to or accepts the review, never log in or register, never enter passwords or personal details, and ignore cookie banners.`;

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'actions', 'note'],
  properties: {
    status: { type: 'string', enum: ['declined', 'already', 'act', 'stuck'] },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'element', 'kind', 'value'],
        properties: {
          frame: { type: 'integer' },
          element: { type: 'integer' },
          kind: { type: 'string', enum: ['click', 'fill', 'select'] },
          value: { type: 'string', description: 'Text to type, or the option text to select; empty for clicks.' },
        },
      },
    },
    note: { type: 'string' },
  },
};

// Returns { name, ask(system, content, schema) } for the LLM chosen on the options page,
// or null when it is turned off.
export async function backend() {
  const { llm = 'codex', codexModel, apiKey, model = 'claude-opus-5-5' } =
    await chrome.storage.local.get(['llm', 'codexModel', 'apiKey', 'model']);
  if (llm === 'codex') return { name: 'codex ' + (codexModel || 'gpt-6.1-sol'), ask: (...a) => askCodex(codexModel, ...a) };
  if (llm === 'anthropic' && apiKey) {
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    return { name: model, ask: (...a) => askClaude(client, model, ...a) };
  }
  return null;
}

export async function askCodex(model, system, content, schema, send = m => chrome.runtime.sendNativeMessage(HOST, m)) {
  const prompt = `${system}\n\nAnswer only from the text below. Do not run any commands.\n\n${content}`;
  const res = await send({ prompt, schema, model });
  if (!res?.ok) throw new Error(res?.error || 'no reply from the codex host (run host/install.sh)');
  return JSON.parse(res.text);
}

async function askClaude(client, model, system, content, schema) {
  const res = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    // Haiku has no server-side refusal fallback.
    ...(!/haiku/.test(model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    system,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason !== 'end_turn') throw new Error(`Claude stopped with ${res.stop_reason}`);
  return JSON.parse(res.content.find(b => b.type === 'text').text);
}

export function classifyEmail(llm, email, me) {
  return llm.ask(EMAIL_SYSTEM, [
    `The user: ${me.join(' / ')}`,
    `Message list line: ${email.listLine}`,
    `Sender address: ${email.sender}`,
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Cc: ${email.cc}`,
    'Body excerpt (links shown as [Ln: link text]):',
    email.text,
  ].join('\n'), EMAIL_SCHEMA);
}

export function planDeclineStep(llm, frames) {
  const pages = frames.map(f => [
    `Frame ${f.frameId}: ${f.url} (title: ${f.title})`,
    `Text: ${f.text}`,
    'Elements:',
    ...f.els.map(e => `  [${e.i}] ${e.tag}${e.type ? `/${e.type}` : ''} "${e.label}"` +
      (e.options ? ` options: ${e.options.join(' | ')}` : '') +
      (e.checked ? ' (checked)' : '') + (e.missing ? ' (required, empty)' : '')),
  ].join('\n'));
  return llm.ask(STEP_SYSTEM, pages.join('\n\n'), STEP_SCHEMA);
}
