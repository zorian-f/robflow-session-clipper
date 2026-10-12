/**
 * MV3 service worker: keeps the freshest Cognito id token and hands the session to the viewer.
 *
 * The session URL (SID) alone gives the viewer a VIEW-ONLY link. Control (moving the robot,
 * pushing/saving flows, reconfiguring) needs the Cognito id token RobCo Studio authenticates with.
 *
 * How robco.studio holds it (read from its bundle): Studio is NOT an Amplify app. It uses
 * axios-jwt, which keeps `{ accessToken, refreshToken }` as JSON in
 * localStorage['auth-tokens-production'] and sends the accessToken (a Cognito id token,
 * token_use:'id') as `Authorization: Bearer …` to api.robco.studio/public. After the Google
 * redirect, its LoginView writes that entry and routes on with the SPA router — no page load —
 * which is why the old build needed a manual refresh to notice the login.
 *
 * Sources feeding captureToken(), freshest expiry wins:
 *   1. content.js on every robco.studio page polls that localStorage entry ('capture-token').
 *   2. On demand (a viewer or the popup asks while our copy is stale): read the entry straight
 *      from any open Studio tab via chrome.scripting.
 *   3. Renewal, when 1-2 have nothing fresher: POST /public/login/refresh-token with Studio's
 *      refresh token, exactly as Studio's own axios-jwt interceptor does (RobCo's backend holds the
 *      Cognito client secret; the call needs none). A connected viewer so stays in control past
 *      the 1 h id-token lifetime, even with no Studio tab open.
 * (v2-era request-header observation is gone: it woke this worker on every api.robco.studio
 * request and only duplicated source 1.)
 *
 * Consumers: the viewer bridge (bridge.js, pull + push) and the RobCo Visual Components add-on
 * (desktop.js, native messaging).
 *
 * Only the id token is ever handed out. The refresh token stays in this worker's storage.session
 * (memory-only, closed to content scripts and pages) and is only ever sent to the refresh endpoint.
 * Studio signing out clears it. Measured 2026-10-12: RobCo echoes the SAME refresh token on renewal
 * (no rotation), so renewing here never invalidates Studio's copy; should rotation ever appear, the
 * new pair is written back into open Studio tabs so Studio stays signed in.
 */
const STUDIO_ORIGIN = 'https://robco.studio';
const STATUS_URL = 'https://api.robco.studio/public/virtual-robot/status';
const REFRESH_URL = 'https://api.robco.studio/public/login/refresh-token';
const SESSION_BASE = 'https://api.robco.studio/public/virtual-robot/session';
const STUDIO_TOKENS_KEY = 'auth-tokens-production';
const SID_RE = /session\/(?:ws\/)?([^/?#]+)/;
const DEFAULT_VIEWER = 'https://orrerium.web.app';
// A token with less than this left is "stale": look for a newer one, else renew. Just over the
// viewer's 5 min keep-alive lead, so its first ask already gets a renewal.
const FRESH_MARGIN_MS = 6 * 60 * 1000;

// Viewer origins the bridge serves: prod + develop sites, the per-branch preview channels CI
// deploys on the prod site (`orrerium--feat-<branch>-<8-char hash>.web.app`, see the viewer's
// firebase-hosting-deploy.yml), and local dev on the viewer's own ports only (Vite dev 3000,
// `vite preview` 4173): any other local server gets nothing.
const VIEWER_WEB_HOST = /^(?:orrerium(?:--feat-[a-z0-9-]+-[a-z0-9]{8})?|orrerium-develop)\.web\.app$/;
const VIEWER_LOCAL_HOST = /^(?:localhost|127\.0\.0\.1)$/;
const VIEWER_LOCAL_PORTS = ['3000', '4173'];
const VIEWER_MATCHES = [ // = bridge.js's manifest matches
    'https://*.web.app/*',
    ...VIEWER_LOCAL_PORTS.flatMap((p) => [`http://localhost:${p}/*`, `http://127.0.0.1:${p}/*`]),
];
const STATUS_TIMEOUT_MS = 4000;
const RENEW_TIMEOUT_MS = 6000;
const RENEW_COOLDOWN_MS = 30 * 1000; // after a failed renewal, before trying again
const TAB_READ_TIMEOUT_MS = 1500;

/** Decode a JWT payload (no verification) → { email, exp, tokenUse }. Best-effort; null on garbage. */
function decodeJwt(token) {
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(part));
        return { email: payload.email || null, exp: payload.exp || null, tokenUse: payload.token_use || null };
    } catch {
        return null;
    }
}

const liveFor = (info, marginMs = 0) => !!(info && info.exp && info.exp * 1000 > Date.now() + marginMs);

// Captures are serialized: the content script, a Studio-tab read and a renewal can all fire
// within milliseconds of each other, and an unserialized read-modify-write could let an older
// token's write land last.
let captureQueue = Promise.resolve();

/**
 * Persist a valid, unexpired Cognito id token if it's strictly fresher than what we already hold.
 * @returns {Promise<boolean>} whether it was stored
 */
function captureToken(token, source) {
    const run = captureQueue.then(() => storeIfFresher(token, source));
    captureQueue = run.catch(() => false);
    return run;
}

async function storeIfFresher(token, source) {
    if (typeof token !== 'string' || !token.startsWith('ey')) return false;
    const info = decodeJwt(token);
    // ONLY the Cognito *id* token authorizes the account API (…/virtual-robot/status + configure).
    // The session 'editor' token (sub:editor) also rides api.robco.studio on session-API calls and
    // would otherwise win on a later expiry — capturing the wrong credential.
    if (!liveFor(info) || info.tokenUse !== 'id') return false;
    const { robflowToken: prev } = await chrome.storage.local.get('robflowToken');
    const prevInfo = prev && prev.value ? decodeJwt(prev.value) : null;
    // Among id tokens keep the later-expiring one; always replace a non-id token left by an old build.
    if (prevInfo && prevInfo.tokenUse === 'id' && prevInfo.exp >= info.exp) return false;
    await chrome.storage.local.set({
        robflowToken: { value: token, email: info.email, exp: info.exp, capturedAt: Date.now(), source },
    });
    syncDesktop(); // desktop.js: hand the new token to the VC add-on (no-op without its helper)
    return true;
}

// --- Refresh token: memory-only, worker-only -------------------------------------------------
// Bumped whenever the login held here changes or ends, so a renewal that was in flight across a
// sign-out or account switch can't write the old login back when it returns.
let loginEpoch = 0;

async function storeRefreshToken(value) {
    if (typeof value !== 'string' || !value) return;
    const s = await chrome.storage.session.get(['robflowRefresh', 'robflowRejected', 'robflowRetired']);
    // Unchanged, one RobCo already rejected, or one a rotation retired (a Studio-tab read taken just
    // before the write-back can still carry it): skip.
    if (value === s.robflowRefresh || value === s.robflowRejected || value === s.robflowRetired) return;
    loginEpoch++;
    await chrome.storage.session.set({ robflowRefresh: value });
    // A (re)gained refresh token - e.g. the first Studio visit after a browser restart - means the
    // desktop side can be kept fresh again: re-sync it and re-arm its renewal alarm.
    syncDesktop();
}
const loadRefreshToken = async () => (await chrome.storage.session.get('robflowRefresh')).robflowRefresh || null;

/** Studio signed out: forget everything so nothing keeps renewing a session the user ended. */
async function forgetLogin() {
    loginEpoch++;
    const { robflowToken } = await chrome.storage.local.get('robflowToken');
    await chrome.storage.session.remove('robflowRefresh');
    await chrome.storage.local.remove('robflowToken');
    await desktopSignedOut((robflowToken && robflowToken.email) || ''); // desktop.js
}

// Run inside a Studio tab (serialized by chrome.scripting — must stay self-contained). Each one
// re-checks the origin: the tab may have navigated away between the query and the injection.
function readStudioTokens(key) {
    if (location.origin !== 'https://robco.studio') return null;
    try {
        const t = JSON.parse(localStorage.getItem(key) || 'null');
        return t && typeof t.accessToken === 'string'
            ? { accessToken: t.accessToken, refreshToken: typeof t.refreshToken === 'string' ? t.refreshToken : null }
            : null;
    } catch {
        return null;
    }
}
function writeStudioTokens(key, oldRefresh, accessToken, refreshToken) {
    if (location.origin !== 'https://robco.studio') return;
    try {
        // Only a tab still on the login we renewed: never clobber a different/newer sign-in.
        const t = JSON.parse(localStorage.getItem(key) || 'null');
        if (t && t.refreshToken === oldRefresh) localStorage.setItem(key, JSON.stringify({ accessToken, refreshToken }));
    } catch {
        /* leave Studio as it is */
    }
}

const studioTabs = () => chrome.tabs.query({ url: `${STUDIO_ORIGIN}/*` });

/** Run `func(...args)` in every open Studio tab; a loading/discarded tab is skipped, never waited on. */
async function inStudioTabs(func, args) {
    const tabs = await studioTabs();
    return Promise.all(tabs.map(async (tab) => {
        try {
            const run = chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
            const timeout = new Promise((resolve) => setTimeout(() => resolve([]), TAB_READ_TIMEOUT_MS));
            const [res] = await Promise.race([run, timeout]);
            return res ? res.result : null;
        } catch {
            return null; // tab not scriptable right now
        }
    }));
}

/** Source 3: pull the current tokens out of every open Studio tab. */
async function readOpenStudioTabs() {
    for (const t of await inStudioTabs(readStudioTokens, [STUDIO_TOKENS_KEY])) {
        if (!t) continue;
        await captureToken(t.accessToken, 'studio-tab');
        await storeRefreshToken(t.refreshToken);
    }
}

// --- Source 4: renewal -------------------------------------------------------------------------
let renewing = null;
let lastRenewFailAt = 0;

/** Renew the id token with the stored refresh token: one request in flight, 30 s apart after a failure. */
function renewIdToken() {
    renewing = renewing || doRenew().finally(() => { renewing = null; });
    return renewing;
}

async function doRenew() {
    if (Date.now() - lastRenewFailAt < RENEW_COOLDOWN_MS) return false;
    const refreshToken = await loadRefreshToken();
    if (!refreshToken) return false;
    const ok = await renewWith(refreshToken, loginEpoch);
    if (!ok) lastRenewFailAt = Date.now();
    return ok;
}

async function renewWith(refreshToken, epoch) {
    let res;
    try {
        res = await fetch(REFRESH_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }), signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
        });
    } catch {
        return false; // offline or timed out: keep the refresh token, retry after the cooldown
    }
    // Revoked or expired: drop it and remember it, so an open Studio tab still holding it doesn't
    // hand it back. The current id token stays usable until its own expiry; a new sign-in at
    // robco.studio brings a new refresh token. (429/408 and 5xx are transient: keep it.)
    if (res.status === 400 || res.status === 401 || res.status === 403) {
        if (epoch === loginEpoch) {
            await chrome.storage.session.set({ robflowRejected: refreshToken });
            await chrome.storage.session.remove('robflowRefresh');
        }
        return false;
    }
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    if (!data || typeof data.access_token !== 'string') return false;
    // A sign-out or another login arrived while the request was out: its result is stale.
    if (epoch !== loginEpoch) return false;
    if (typeof data.refresh_token === 'string' && data.refresh_token && data.refresh_token !== refreshToken) {
        // Rotation: the old refresh token, Studio's copy included, is dead now. Keep open Studio
        // tabs in step so Studio doesn't sign out on its next renewal.
        await chrome.storage.session.set({ robflowRetired: refreshToken });
        await storeRefreshToken(data.refresh_token);
        await inStudioTabs(writeStudioTokens, [STUDIO_TOKENS_KEY, refreshToken, data.access_token, data.refresh_token]);
    }
    return captureToken(data.access_token, 'renewed');
}

/** The account's CURRENT session SID (the page-detected one goes stale when the session re-provisions). */
async function fetchSid(token) {
    const res = await fetch(STATUS_URL, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`/status → HTTP ${res.status}`);
    const data = await res.json();
    return (data && data.token) || null;
}

/**
 * Everything a viewer needs to connect: a fresh SID and, when we hold a live one, the id token.
 * @returns {Promise<{sid: string|null, token: string|null, email?: string, exp?: number, reason?: string}>}
 */
async function getSession() {
    const stored = async () => (await chrome.storage.local.get('robflowToken')).robflowToken;
    const fresh = (r) => liveFor(r && r.value ? decodeJwt(r.value) : null, FRESH_MARGIN_MS);
    let rec = await stored();
    if (!fresh(rec)) {
        await readOpenStudioTabs(); // Studio may have renewed it since we last looked
        rec = await stored();
    }
    if (!fresh(rec) && await renewIdToken()) rec = await stored();
    const { robflowSessionUrl } = await chrome.storage.local.get('robflowSessionUrl');
    const pageSid = ((robflowSessionUrl || '').match(SID_RE) || [])[1] || null;
    const info = rec && rec.value ? decodeJwt(rec.value) : null;
    if (!liveFor(info)) {
        return { sid: pageSid, token: null, reason: rec ? 'token expired — sign in at robco.studio' : 'no token yet — sign in at robco.studio' };
    }
    let sid = pageSid;
    try {
        sid = (await fetchSid(rec.value)) || pageSid;
        if (sid) await chrome.storage.local.set({ robflowSessionUrl: `${SESSION_BASE}/${sid}/` });
    } catch {
        /* keep the page-detected SID */
    }
    return { sid, token: rec.value, email: info.email, exp: info.exp };
}

/** An origin our bridge.js serves (keep in sync with its manifest matches + host check). */
function isBridgedUrl(u) {
    if (u.protocol === 'https:') return VIEWER_WEB_HOST.test(u.hostname);
    return u.protocol === 'http:' && VIEWER_LOCAL_HOST.test(u.hostname) && VIEWER_LOCAL_PORTS.includes(u.port);
}

/**
 * Open the viewer on the current session. A bridged viewer pulls the token itself, so it never
 * lands in the URL/history; only a custom (non-bridged) viewer URL still gets `&token=`.
 */
async function openViewer() {
    const s = await getSession();
    if (!s.sid) return { ok: false, reason: s.reason || 'No session yet: open one in RobCo Studio.' };
    const { viewerBaseUrl } = await chrome.storage.local.get('viewerBaseUrl');
    const root = (viewerBaseUrl || DEFAULT_VIEWER).replace(/[?#].*$/, '').replace(/\/+$/, '');
    let bridged = false;
    try { bridged = isBridgedUrl(new URL(root)); } catch { /* invalid custom URL → treat as not bridged */ }
    const q = new URLSearchParams({ robco: 'session', sid: s.sid });
    if (s.token && !bridged) q.set('token', s.token);
    await chrome.tabs.create({ url: `${root}/?${q.toString()}` });
    return { ok: true, control: !!s.token };
}

function senderUrl(sender) {
    try { return new URL(sender.url); } catch { return null; }
}

function isStudioSender(sender) {
    const u = senderUrl(sender);
    return !!u && u.origin === STUDIO_ORIGIN;
}

/** The bridge, running top-level on an allowed viewer origin. */
function isViewerSender(sender) {
    const u = senderUrl(sender);
    return !!u && !!sender.tab && sender.frameId === 0 && isBridgedUrl(u);
}

const isPopupSender = (sender) => sender.url === chrome.runtime.getURL('popup.html');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== chrome.runtime.id) return false;
    // Source 1: our Studio content script's localStorage read.
    if (msg.type === 'capture-token' && isStudioSender(sender)) {
        captureToken(msg.token, 'studio-storage');
        storeRefreshToken(msg.refreshToken);
        sendResponse({ ok: true }); // ack receipt so content.js stops resending this token
        return false;
    }
    // Studio's tokens are gone (sign-out, or Studio's own 401 handling): stop renewing a session
    // the user ended.
    if (msg.type === 'studio-signed-out' && isStudioSender(sender)) {
        forgetLogin();
        sendResponse({ ok: true });
        return false;
    }
    // A viewer bridge or the popup wants the session. Never answer anyone else.
    if (msg.type === 'get-session' && (isViewerSender(sender) || isPopupSender(sender))) {
        getSession().then(sendResponse, (e) => sendResponse({ sid: null, token: null, reason: String((e && e.message) || e) }));
        // Opening the popup also (re)links the VC add-on right away - e.g. just after its helper was
        // installed, when the stored token is still fresh and nothing else would push for ~55 min.
        if (isPopupSender(sender)) syncDesktop();
        return true; // async response
    }
    // The popup's button or the one injected on the Studio session page.
    if (msg.type === 'open-viewer' && (isStudioSender(sender) || isPopupSender(sender))) {
        openViewer().then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
        return true;
    }
    return false;
});

// Content scripts are only auto-injected on page LOAD, so after an install/update/reload the
// already-open Studio and viewer tabs would stay blind until refreshed. Inject into them now
// (bridge.js checks its own host; an orphaned copy from before the reload stays silent).
chrome.runtime.onInstalled.addListener(async () => {
    for (const tab of await studioTabs()) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
    for (const tab of await chrome.tabs.query({ url: VIEWER_MATCHES })) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bridge.js'] }).catch(() => {});
    }
    syncDesktop(); // a stored, still-valid token reaches the VC add-on without waiting for a change
});

// On worker startup drop a stored credential that's expired OR not a Cognito id token (flushes an
// old build's editor token) so nothing ever offers a stale or wrong-scope credential.
chrome.storage.local.get(['robflowToken'], ({ robflowToken }) => {
    const info = robflowToken && robflowToken.value ? decodeJwt(robflowToken.value) : null;
    if (robflowToken && (!liveFor(info) || info.tokenUse !== 'id')) {
        chrome.storage.local.remove('robflowToken');
    }
});

// The VC add-on handoff (native messaging + its renewal alarm). importScripts must run during the
// worker's first evaluation so desktop.js's listeners are registered on every wake.
importScripts('desktop.js');
