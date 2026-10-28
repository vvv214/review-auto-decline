// Deterministic checks for the review systems seen so far (Editorial Manager, ScholarOne).
// Each returns null when it doesn't recognize the input, and the LLM decides instead.

// Labels the decline driver must never click, whoever proposed the click.
export const NEVER = /\b(agree|accept|log ?in|sign ?in|register|remove my|unsubscribe|update my)/i;

const GO = /^(i )?(decline|confirm|submit|yes|ok|continue|send)\b/i;
const DONE = /decline review confirmation|you have (successfully )?declined|has been declined|declined (this|the) (invitation|review)|thank you for (your response|responding|replying|letting us know)|response (of "?declined"? )?has been (recorded|received|submitted)/i;
const ALREADY = /already (responded|declined|agreed|accepted|been (declined|accepted))|no longer (available|valid|active|required)|(invitation|link) (has )?expired|has been (withdrawn|rescinded|cancell?ed)/i;

export function classifyEmail(email) {
  const line = email.listLine;
  if (/Editorial Manager Registration|Account Created in ScholarOne/i.test(line)) return { category: 'registration' };
  if (/\(DECLINED\)|Thank you for responding to our peer review invitation|unfortunate that you are unable to review/i.test(line)) return { category: 'decline_confirmation' };
  const link = email.links.findIndex(l => /^decline to review$/i.test(l.text) || /\bDeclined?:\s*$/.test(l.before));
  if (link >= 0 && /invit/i.test(line)) return { category: 'review_invitation', decline_link: link };
  return null;
}

// frames: page snapshots from every frame of the decline tab (see snapshot() in background.js).
export function declineStep(frames) {
  const text = frames.map(f => f.title + ' ' + f.text).join(' ');
  // Links count too: ScholarOne's "I Confirm This Response" is a link styled as a button.
  const buttons = frames.flatMap(f => f.els
    .filter(e => e.tag === 'button' || e.tag === 'a' || /^(submit|button)$/.test(e.type))
    .map(e => ({ frame: f.frameId, ...e })));
  const go = buttons.filter(b => GO.test(b.label) && !NEVER.test(b.label));
  if (ALREADY.test(text)) return { status: 'already', note: 'page says the invitation was already answered or closed' };
  if (DONE.test(text) && !go.length) return { status: 'declined', note: 'confirmation page' };
  if (go.length === 1 && !frames.some(f => f.els.some(e => e.missing))) {
    return { status: 'act', actions: [{ frame: go[0].frame, element: go[0].i, kind: 'click', value: '' }], note: `clicked "${go[0].label}"` };
  }
  return null;
}
