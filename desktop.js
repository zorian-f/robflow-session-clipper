/**
 * Hands the Studio session to the RobCo Visual Components add-on through Chrome native messaging.
 *
 * The add-on's installer registers a native-messaging host (com.robco.session_clipper) whose
 * manifest allows ONLY this extension's ID (pinned by the manifest `key`). Whenever the stored id
 * token changes we send it with the current SID; Chrome starts the host, which writes it
 * DPAPI-encrypted for the add-on and exits. An alarm renews the token shortly before it expires,
 * so VC stays in control with no viewer open. Without the host installed, a push is one failed
 * lookup and nothing else: no alarm is armed.
 *
 * Only the id token crosses (never the refresh token). Loaded by background.js via importScripts
 * and shares its scope (getSession).
 */
const DESKTOP_HOST = 'com.robco.session_clipper';
const DESKTOP_ALARM = 'robflow-desktop-renew';
// Renew this long before expiry: inside background.js's FRESH_MARGIN_MS, so the alarm's
// getSession() actually renews instead of returning the old token.
const DESKTOP_LEAD_MS = 5 * 60 * 1000;
const DESKTOP_MIN_DELAY_MS = 30 * 1000;  // never re-arm tighter than this
const DESKTOP_RETRY_MS = 60 * 1000;      // after a failed delivery, or while a renewal keeps failing
// Chrome's errors for "no usable host installed" (vs. a host that crashed or failed to start)
const HOST_ABSENT = /not found|forbidden/i;

let desktopSyncing = null;
let desktopAgain = false;
let desktopEpoch = 0;     // bumped on sign-out: a push already under way must not land after it
let lastPushed = null;    // { token, sid } the host last confirmed - never send the same twice
let sendQueue = Promise.resolve(); // native messages go out strictly in order

/** Push the current session to the desktop host: one push in flight, at most one queued behind it. */
function syncDesktop() {
    if (desktopSyncing) {
        desktopAgain = true;
        return desktopSyncing;
    }
    desktopSyncing = (async () => {
        do {
            desktopAgain = false;
            try { await pushSession(); } catch { /* the next change or alarm retries */ }
        } while (desktopAgain);
    })().finally(() => { desktopSyncing = null; });
    return desktopSyncing;
}

const recordDesktop = (ok, error) => chrome.storage.local.set({ desktopSync: { ok, at: Date.now(), error } });

/** One native message, in order behind any earlier one. → 'ok' | 'failed' | 'absent'. */
function sendDesktop(message) {
    const run = sendQueue.then(async () => {
        try {
            const reply = await chrome.runtime.sendNativeMessage(DESKTOP_HOST, message);
            const ok = !!(reply && reply.ok);
            await recordDesktop(ok, ok ? null : String((reply && reply.error) || 'no reply'));
            return ok ? 'ok' : 'failed';
        } catch (e) {
            const why = String((e && e.message) || e);
            if (HOST_ABSENT.test(why)) {
                // The usual case without the VC add-on: forget it, arm nothing.
                await chrome.storage.local.remove('desktopSync');
                await chrome.alarms.clear(DESKTOP_ALARM);
                return 'absent';
            }
            await recordDesktop(false, why); // crashed / couldn't start: retried by the alarm
            return 'failed';
        }
    });
    sendQueue = run.catch(() => 'failed');
    return run;
}

async function pushSession() {
    const epoch = desktopEpoch;
    const s = await getSession(); // the current SID; renews first when the token is stale
    if (epoch !== desktopEpoch || !s.token || !s.sid) return; // signed out meanwhile, or nothing to send
    const same = !!lastPushed && lastPushed.token === s.token && lastPushed.sid === s.sid;
    let outcome = 'ok';
    if (!same) {
        outcome = await sendDesktop({ type: 'session', token: s.token, sid: s.sid });
        if (outcome === 'absent' || epoch !== desktopEpoch) return;
        if (outcome === 'ok') lastPushed = { token: s.token, sid: s.sid };
    }
    // Next run: ~5 min before expiry. A failed delivery - or the same token again because a
    // renewal keeps failing - retries in a minute (bounded by the token's own expiry).
    const retry = outcome === 'failed' || same;
    const when = Math.max(Date.now() + (retry ? DESKTOP_RETRY_MS : DESKTOP_MIN_DELAY_MS),
        s.exp * 1000 - DESKTOP_LEAD_MS);
    await chrome.alarms.create(DESKTOP_ALARM, { when });
}

/** Studio signed out: tell the add-on (it drops a token it got from us) and stop renewing. */
async function desktopSignedOut(email) {
    desktopEpoch++;
    lastPushed = null;
    await chrome.alarms.clear(DESKTOP_ALARM);
    const { desktopSync } = await chrome.storage.local.get('desktopSync');
    // queued behind any session message already on its way, so the sign-out always lands last
    if (desktopSync) await sendDesktop({ type: 'signed-out', email: email || '' });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DESKTOP_ALARM) syncDesktop();
});

// Alarms may not survive a browser restart; the stored token usually does. Re-sync on start so
// VC gets the current state and the renewal alarm is armed again.
chrome.runtime.onStartup.addListener(() => { syncDesktop(); });
