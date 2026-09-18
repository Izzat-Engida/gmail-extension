// The send loop lives in the Gmail tab, not here. An MV3 service worker is
// terminated after roughly 30 seconds idle, which killed campaigns mid-run.
// All this does now is locate a Gmail tab and open the panel in it.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function ask(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(response || null);
    });
  });
}

// Gmail puts the account index in the path: /mail/u/0/ is the default account,
// /mail/u/1/ and up are additional signed-in accounts. A bare URL resolves to
// the default.
//
// The panel used to be pinned to u/0. That made every other signed-in account
// invisible — including the ones cold outreach had actually been sent from, so
// their history could not be imported and their deliverability could not be
// measured. It now runs in whichever Gmail tab you are looking at, and the
// panel states the address so the account is a deliberate choice rather than an
// assumption. History is shared storage, so importing from several accounts
// merges into one picture.
function accountIndex(url) {
  const m = (url || "").match(/mail\.google\.com\/mail\/u\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function findGmailTabs() {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/*" });
  return tabs.sort((a, b) => accountIndex(a.url) - accountIndex(b.url));
}

// Prefer the tab the user is actually looking at — that is the account they
// mean. Fall back to any open Gmail tab, then to opening the default.
async function findOrCreateGmailTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /mail\.google\.com/.test(active.url || "")) return active;

  const open = await findGmailTabs();
  if (open.length) return open[0];

  const tab = await chrome.tabs.create({
    url: "https://mail.google.com/mail/u/0/#inbox",
    active: true,
  });
  await waitForTabComplete(tab.id);
  // Gmail keeps building its UI well after the load event.
  await sleep(3000);
  return tab;
}

// A Gmail tab opened before this extension was installed or reloaded has no
// content script in it, so inject one on demand.
async function ensureContentScript(tabId) {
  const pong = await ask(tabId, { type: "PING" });
  if (pong && pong.ok) return pong;

  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await sleep(500);
  return await ask(tabId, { type: "PING" });
}

async function getAccount() {
  const tabs = await findGmailTabs();
  if (!tabs.length) return { account: null, gmailOpen: false };
  const pong = await ensureContentScript(tabs[0].id);
  return { account: pong ? pong.account : null, gmailOpen: true };
}

async function openPanel() {
  try {
    const tab = await findOrCreateGmailTab();
    const pong = await ensureContentScript(tab.id);
    if (!pong || !pong.ok) {
      return { ok: false, error: "Could not reach the Gmail tab — reload it and retry." };
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    const res = await ask(tab.id, { type: "SHOW_PANEL" });
    return res && res.ok ? { ok: true } : { ok: false, error: "Panel did not open." };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Walks every signed-in Gmail account and pulls its Sent mail, replies and
// bounces into the shared history — so the dashboard shows everything sent from
// every address without anyone opening each mailbox and clicking Import.
//
// Gmail numbers signed-in accounts /mail/u/0/, /mail/u/1/ and so on, with no
// index anywhere of how many there are. Probing upward and stopping after two
// consecutive misses is the only way to enumerate them, and is cheap: a signed
// -out index redirects and reports no address.
const MAX_ACCOUNT_PROBE = 6;

// Addresses this Gmail account can send *as*. Mail sent through a "Send mail
// as" alias is stored in Gmail's Sent folder, not on the alias's own mail
// server, so these have to be searched explicitly or that outreach is invisible.
// Overridable from storage; these are the defaults because they are the
// addresses the outreach actually went out from.
// Business outreach only. Searching by domain rather than by exact address
// catches every alias on these domains — dawit@, michaelg@, any future one —
// while never matching the personal gmail.com account the aliases are attached
// to. An earlier version ran an unfiltered in:sent pass as a safety net, which
// worked by hoovering up private correspondence; that is not a safety net, it
// is a privacy problem.
const DEFAULT_DOMAINS = [
  "zemenaytech.com",
  "africanrecruitment.com",
];

// Known exact addresses, used after the domain sweep purely to attribute each
// message to the specific alias that sent it.
const DEFAULT_ALIASES = [
  "dawit@africanrecruitment.com",
  "michaelg@zemenaytech.com",
  "dawit@zemenaytech.com",
];

function getSenders() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["sendAliases", "sendDomains"], (d) => {
      resolve({
        domains: (Array.isArray(d.sendDomains) ? d.sendDomains : DEFAULT_DOMAINS).filter(Boolean),
        aliases: (Array.isArray(d.sendAliases) ? d.sendAliases : DEFAULT_ALIASES).filter(Boolean),
      });
    });
  });
}

async function syncAllAccounts({ days = 180, onStep } = {}) {
  const results = [];
  const senders = await getSenders();
  const existing = await findGmailTabs();
  const opened = [];
  let misses = 0;

  for (let idx = 0; idx < MAX_ACCOUNT_PROBE && misses < 2; idx++) {
    let tab = existing.find((t) => accountIndex(t.url) === idx);
    let temporary = false;

    if (!tab) {
      // Background tab: the sync should not steal the window while it works.
      tab = await chrome.tabs.create({
        url: `https://mail.google.com/mail/u/${idx}/#inbox`,
        active: false,
      });
      await waitForTabComplete(tab.id);
      await sleep(3500); // Gmail keeps building well past the load event
      temporary = true;
      opened.push(tab.id);
    }

    const pong = await ensureContentScript(tab.id);
    const account = pong && pong.account;
    if (!account) {
      // A signed-out index still cost us a tab. Close it here rather than at
      // the end of the loop body, which this path skips.
      if (temporary) { try { await chrome.tabs.remove(tab.id); } catch {} }
      misses++;
      continue;
    }
    misses = 0;

    onStep?.({ phase: "import", account });
    const imported = await ask(tab.id, { type: "RUN_IMPORT", days, ...senders });
    onStep?.({ phase: "scan", account });
    const scanned = await ask(tab.id, { type: "RUN_SCAN", days: 90 });

    results.push({
      account,
      imported: imported?.imported || 0,
      updated: imported?.updated || 0,
      // Per-identity counts make it obvious whether the alias mail was found,
      // rather than leaving a zero total to be interpreted.
      byIdentity: imported?.byIdentity || {},
      replies: scanned?.replies || 0,
      bounces: scanned?.bounces || 0,
      error: imported?.error || scanned?.error || null,
    });

    // Only close what this sync opened; a tab the user had is left as found.
    if (temporary) { try { await chrome.tabs.remove(tab.id); } catch {} }
  }

  await chrome.storage.local.set({ lastSyncAt: Date.now() });
  return { accounts: results };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_ACCOUNT") {
    getAccount().then(sendResponse);
    return true;
  }
  if (msg.type === "SYNC_ALL") {
    syncAllAccounts({ days: msg.days || 180 })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === "OPEN_PANEL") {
    openPanel().then(sendResponse);
    return true;
  }
  return false;
});

// There is no popup: the toolbar icon opens the panel in the Gmail tab you are
// looking at, whichever account that is.
chrome.action.onClicked.addListener(() => openPanel());
