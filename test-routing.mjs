// Exercises the segment routing and pre-flight logic against the real lead
// files, without a browser. The extension's DOM code can only be tested in
// Gmail, but the parts that decide what gets sent to whom are pure functions
// and there is no excuse for shipping those unverified.

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

// Pull the pure block out of the content script: everything from the segment
// definitions through the suppression helpers.
const start = src.indexOf('const SEGMENTS = [');
const end = src.indexOf('// -------------------------------------------------------------------- Panel');
const block = src.slice(start, end);

const chromeStub = { storage: { local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb() } } };
const fillTemplate = (template, row) =>
  template.replace(/\{\{(\w+)\}\}/g, (m, k) => (row[k.toLowerCase()] !== undefined ? row[k.toLowerCase()] : m));

const sandbox = new Function('chrome', 'fillTemplate', `
  ${block}
  return { SEGMENTS, routeContact, preflight, addSuppression, get suppressed() { return suppressed; },
           set suppressed(v) { suppressed = v; } };
`)(chromeStub, fillTemplate);

const { SEGMENTS, routeContact, preflight } = sandbox;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const split = line => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out.map(s => s.trim());
  };
  const headers = split(lines[0]).map(h => h.toLowerCase());
  return lines.slice(1).map(l => {
    const cells = split(l); const row = {};
    headers.forEach((h, i) => row[h] = cells[i] || '');
    return row;
  });
}

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

console.log('routing rules:');
check('property manager -> call centre', routeContact({ vertical: 'property & real estate' }), 'callcenter');
check('law firm -> call centre', routeContact({ vertical: 'legal' }), 'callcenter');
check('dental -> call centre', routeContact({ vertical: 'dental' }), 'callcenter');
check('accounting -> VA', routeContact({ vertical: 'finance & accounting' }), 'va');
check('hotel -> VA', routeContact({ vertical: 'hospitality & travel' }), 'va');
check('open eng roles beat vertical', routeContact({ vertical: 'legal', eng_roles: '4' }), 'tech');
check('support roles -> VA', routeContact({ vertical: 'other', support_roles: '2' }), 'va');
check('explicit column wins', routeContact({ vertical: 'legal', segment: 'tech' }), 'tech');
check('unknown falls back', routeContact({ vertical: 'zzz nonsense' }), 'callcenter');

console.log('\npre-flight guards:');
const tpl = {
  callcenter: { subject: 'calls at {{company}}', body: 'Hi — {{company}} is {{hours_gap}}.' },
  tech: { subject: 'x', body: 'y' },
  va: { subject: 'x', body: 'y' },
};
const issues = preflight([
  { email: 'a@x.com', company: 'Acme', hours_gap: 'closed weekends', vertical: 'legal' },
  { email: 'b@x.com', company: 'Beta', hours_gap: '', vertical: 'legal' },            // empty field
  { email: 'a@x.com', company: 'Dupe', hours_gap: 'x', vertical: 'legal' },           // duplicate
  { email: 'not-an-email', company: 'Bad', vertical: 'legal' },                        // invalid
], tpl);
check('clean row not flagged', issues.blank.length + issues.unfilled.length, 1);
check('empty merge field caught', issues.blank[0]?.fields.join(), 'hours_gap');
check('duplicate caught', issues.dupe.length, 1);
check('invalid address caught', issues.noEmail.length, 1);

const missing = preflight(
  [{ email: 'c@x.com', company: 'Gamma', vertical: 'legal' }],
  { callcenter: { subject: 's', body: 'Hi {{nonexistent_column}}' }, tech: {}, va: {} }
);
check('missing column caught', missing.unfilled[0]?.fields.join(), '{{nonexistent_column}}');

console.log('\nfollow-up and history logic:');
{
  // The history block is a separate slice of the file from the segment block.
  const hStart = src.indexOf('let history = {};');
  const hEnd = src.indexOf('// ------------------------------------------------------- reply/bounce scanning');
  // recordSend stamps the sending mailbox onto each touch, which in the browser
  // comes from the Gmail DOM; stub it so the record shape can be asserted here.
  const hist = new Function('chrome', 'detectAccount', `
    ${src.slice(hStart, hEnd)}
    return { set: (h) => { history = h; }, followUpDue, historyStats, recordSend,
             get history() { return history; } };
  `)(chromeStub, () => 'dawit@zemenaytech.com');

  const DAY = 86400000;
  const now = Date.now();
  hist.set({
    'fresh@x.com':   { email:'fresh@x.com',   lastSentAt: now - 1 * DAY, touches:[{}],       repliedAt:null, bouncedAt:null },
    'due@x.com':     { email:'due@x.com',     lastSentAt: now - 5 * DAY, touches:[{}],       repliedAt:null, bouncedAt:null },
    'replied@x.com': { email:'replied@x.com', lastSentAt: now - 9 * DAY, touches:[{}],       repliedAt: now, bouncedAt:null },
    'bounced@x.com': { email:'bounced@x.com', lastSentAt: now - 9 * DAY, touches:[{}],       repliedAt:null, bouncedAt: now },
    'maxed@x.com':   { email:'maxed@x.com',   lastSentAt: now - 9 * DAY, touches:[{},{},{}], repliedAt:null, bouncedAt:null },
  });

  const due = hist.followUpDue().map(h => h.email);
  check('too recent is not due', due.includes('fresh@x.com'), false);
  check('past the window is due', due.includes('due@x.com'), true);
  check('a reply stops follow-ups', due.includes('replied@x.com'), false);
  check('a bounce stops follow-ups', due.includes('bounced@x.com'), false);
  check('three touches is the ceiling', due.includes('maxed@x.com'), false);
  check('exactly one due', due.length, 1);

  const s = hist.historyStats();
  check('contacts counted', s.contacts, 5);
  check('emails counted across touches', s.emails, 7);
  check('reply rate', s.replyRate, 20);
  check('bounce rate', s.bounceRate, 20);

  // A second send to the same contact appends rather than overwrites.
  hist.set({});
  hist.recordSend({ email: 'A@X.com', company: 'Acme' }, 'callcenter', 'first');
  hist.recordSend({ email: 'a@x.com', company: 'Acme' }, 'callcenter', 'second', { followUp: true });
  const rec = hist.history['a@x.com'];
  check('address is normalised', Boolean(rec), true);
  check('touches accumulate', rec?.touches.length, 2);
  check('follow-up counted', rec?.followUps, 1);
  // Without the sending mailbox on the record, per-domain deliverability —
  // the reason two addresses are in play at all — cannot be computed.
  check('sending account recorded', rec?.account, 'dawit@zemenaytech.com');
  check('account stamped on each touch', rec?.touches.every(t => t.from === 'dawit@zemenaytech.com'), true);
}

console.log('\nmulti-account sync:');
{
  const bg = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const s = bg.indexOf('const MAX_ACCOUNT_PROBE');
  const e = bg.indexOf('chrome.runtime.onMessage.addListener');

  // Simulated browser: accounts 0 and 2 signed in, 1 signed out (a real gap —
  // Gmail indices are not contiguous once an account is removed).
  const signedIn = { 0: 'dawit@zemenaytech.com', 2: 'dawit@africanrecruitment.com' };
  const created = [], removed = [];
  let lastImportMsg = null;
  let nextTabId = 100;

  const chromeSim = {
    tabs: {
      query: async () => [],                       // no Gmail tabs already open
      create: async ({ url }) => {
        const id = nextTabId++;
        created.push({ id, url });
        return { id, url };
      },
      remove: async (id) => { removed.push(id); },
      onUpdated: { addListener: (fn) => fn(nextTabId - 1, { status: 'complete' }), removeListener: () => {} },
      sendMessage: (id, msg, cb) => {
        const tab = created.find(t => t.id === id);
        const idx = Number((tab.url.match(/\/u\/(\d+)\//) || [])[1]);
        const account = signedIn[idx] || null;
        if (msg.type === 'PING') return cb({ ok: true, account });
        if (msg.type === 'RUN_IMPORT') {
          // The sync must pass the send-as aliases through, or mail sent as
          // dawit@… is never searched for and stays invisible.
          lastImportMsg = msg;
          return cb({ ok: true, account, imported: 12, updated: 3 });
        }
        if (msg.type === 'RUN_SCAN') return cb({ ok: true, account, replies: 2, bounces: 1 });
        cb(null);
      },
    },
    scripting: { executeScript: async () => {} },
    storage: { local: { set: async () => {}, get: (k, cb) => cb({}) } },
    runtime: { lastError: null },
  };

  const helpers = `
    function sleep(){ return Promise.resolve(); }
    function waitForTabComplete(){ return Promise.resolve(); }
    function ask(tabId, msg){ return new Promise(r => chrome.tabs.sendMessage(tabId, msg, r)); }
    function accountIndex(url){ const m=(url||'').match(/mail\\.google\\.com\\/mail\\/u\\/(\\d+)/); return m?Number(m[1]):0; }
    async function findGmailTabs(){ return []; }
    async function ensureContentScript(id){ return ask(id, {type:'PING'}); }
  `;

  const { syncAllAccounts } = new Function('chrome', `
    ${helpers}
    ${bg.slice(s, e)}
    return { syncAllAccounts };
  `)(chromeSim);

  const res = await syncAllAccounts({ days: 180 });
  const accounts = res.accounts.map(a => a.account);

  check('finds both signed-in accounts', accounts.length, 2);
  check('includes zemenaytech', accounts.includes('dawit@zemenaytech.com'), true);
  check('includes africanrecruitment', accounts.includes('dawit@africanrecruitment.com'), true);
  check('skips the signed-out gap', accounts.includes(null), false);
  // Probing must not stop at the first gap or index 2 would never be reached.
  check('probes past a single gap', created.length >= 3, true);
  // Every tab this opened must be closed again, or a sync leaves clutter behind.
  check('closes every tab it opened', removed.length, created.length);
  check('aggregates per-account counts', res.accounts[0].imported, 12);
  check('aggregates scan results', res.accounts[0].replies, 2);
  check('passes send-as aliases to the import', Array.isArray(lastImportMsg?.aliases), true);
  // Three send-as addresses, confirmed against the account's own alias list.
  check('defaults to all three send-as aliases', lastImportMsg?.aliases?.length, 3);
  check('includes the michaelg zemenaytech alias', lastImportMsg?.aliases?.includes('michaelg@zemenaytech.com'), true);
}

console.log('\nagainst the real master list:');
try {
  const rows = parseCsv(readFileSync('D:/leads/out/zemenay-master-leads.csv', 'utf8'));
  const tally = {};
  for (const r of rows) { const s = routeContact(r); tally[s] = (tally[s] || 0) + 1; }
  for (const s of SEGMENTS) {
    const n = tally[s.id] || 0;
    console.log(`  ${s.label.padEnd(20)} ${String(n).padStart(5)}  (${Math.round(n / rows.length * 100)}%)`);
  }
  const real = preflight(rows.slice(0, 500), {
    callcenter: { subject: 'after-hours calls at {{company}}', body: 'Hi — I saw {{company}} is {{hours_gap}}.' },
    tech: { subject: 's', body: 'b' }, va: { subject: 's', body: 'b' },
  });
  console.log(`\n  of the first 500 rows: ${real.blank.length} would send with a blank merge field,`);
  console.log(`  ${real.unfilled.length} reference a missing column, ${real.dupe.length} duplicates, ${real.noEmail.length} bad addresses`);
} catch (e) {
  console.log('  master list not readable:', e.message);
}

console.log(failures ? `\n${failures} FAILED` : '\nall routing and pre-flight checks passed');
process.exit(failures ? 1 : 0);
