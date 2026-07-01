/**
 * MV3 service worker — captures the Cognito id token that authorizes RobFlow control.
 *
 * The session URL (SID) alone gives the viewer a VIEW-ONLY link. Control (moving the robot,
 * pushing/saving flows) needs the Cognito id token sent as `Authorization: Bearer …` on every
 * request to api.robco.studio — the same header the manual flow tells you to copy from DevTools.
 * We OBSERVE (never block/modify) that traffic and keep the freshest token in storage.
 *
 * Two sources feed captureToken(), freshest-expiry wins:
 *   1. webRequest.onBeforeSendHeaders here (observational; valid in MV3 — only *blocking*
 *      webRequest was restricted). The reliable source: the token provably rides this header.
 *   2. A content-script localStorage read (content.js) via the 'capture-token' message — an
 *      on-demand source that doesn't depend on a request firing.
 */
const API_MATCH = 'https://api.robco.studio/*';
const STUDIO_ORIGIN = 'https://robco.studio';

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

/** Persist only a valid, unexpired token that's strictly fresher than what we already hold. */
function captureToken(token) {
    if (!token || !token.startsWith('ey')) return;
    const info = decodeJwt(token);
    if (!info || !info.exp || info.exp * 1000 <= Date.now()) return; // reject invalid/expired
    // ONLY the Cognito *id* token authorizes the account API (…/public/virtual-robot/status +
    // configure). The session 'editor' token (sub:editor) and any access token also ride
    // api.robco.studio on session-API calls and would otherwise overwrite the id token here
    // (freshest-expiry wins) — capturing the wrong credential. Cognito id tokens carry token_use:'id'.
    if (info.tokenUse !== 'id') return;
    chrome.storage.local.get(['robflowToken'], ({ robflowToken }) => {
        const prev = robflowToken && robflowToken.value ? decodeJwt(robflowToken.value) : null;
        // Among id tokens keep the later-expiring one; but always replace a non-id token left by a
        // pre-fix build (else a stale editor token with a later expiry would block a fresh id token).
        if (prev && prev.tokenUse === 'id' && prev.exp >= info.exp) return;
        chrome.storage.local.set({
            robflowToken: { value: token, email: info.email, exp: info.exp, capturedAt: Date.now() },
        });
    });
}

// Source 1: observe outgoing request headers to the RobFlow API and lift the Bearer token.
// Registered at top level so the (non-persistent) service worker re-arms it on wake.
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const auth = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'authorization');
        if (!auth || !auth.value) return;
        const m = auth.value.match(/^Bearer\s+(.+)$/i);
        if (m) captureToken(m[1].trim());
    },
    { urls: [API_MATCH] },
    ['requestHeaders', 'extraHeaders'],
);

// Source 2: token offered by our content script (localStorage read). Validate the sender is
// our own extension running on robco.studio before trusting the payload.
chrome.runtime.onMessage.addListener((msg, sender) => {
    const fromStudio = sender.origin === STUDIO_ORIGIN || (sender.url || '').startsWith(`${STUDIO_ORIGIN}/`);
    if (msg && msg.type === 'capture-token' && msg.token && sender.id === chrome.runtime.id && fromStudio) {
        captureToken(msg.token);
    }
    return false; // fire-and-forget; no response expected
});

// On worker startup drop a stored credential that's expired OR not a Cognito id token (flushes a
// pre-fix editor token) so the popup never offers a stale or wrong-scope credential.
chrome.storage.local.get(['robflowToken'], ({ robflowToken }) => {
    const info = robflowToken && robflowToken.value ? decodeJwt(robflowToken.value) : null;
    if (robflowToken && (!info || !info.exp || info.exp * 1000 <= Date.now() || info.tokenUse !== 'id')) {
        chrome.storage.local.remove('robflowToken');
    }
});
