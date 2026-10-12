/**
 * Viewer bridge: lets the robot viewer (Orrerium) pull the Studio session from this extension
 * instead of receiving the token in its URL.
 *
 * Runs at document_start, top frame only, on the viewer's origins. The manifest has to match all of
 * *.web.app to cover Firebase preview channels; the host check below narrows it to the viewer's own
 * sites, so nothing is ever answered on another web.app page.
 *
 * Protocol (same-window postMessage, origin-checked both ways; the viewer's src/robco/clipperBridge.js):
 *   page → ext  { source: 'orrerium', type: 'clipper:request', id }
 *   ext → page  { source: 'robflow-clipper', type: 'session', id, sid, token, email, exp, reason }
 *   ext → page  { source: 'robflow-clipper', type: 'token', token, email, exp }   (push on renewal)
 * Only the short-lived Cognito id token ever crosses; the extension never holds a refresh token.
 */
(() => {
    // Keep in sync with background.js isBridgedUrl(). Local dev only on the viewer's own ports.
    const WEB_HOST = /^(?:orrerium(?:--feat-[a-z0-9-]+-[a-z0-9]{8})?|orrerium-develop)\.web\.app$/;
    const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1)$/;
    const LOCAL_PORTS = ['3000', '4173'];
    const ok = location.protocol === 'https:' ? WEB_HOST.test(location.hostname)
        : location.protocol === 'http:' && LOCAL_HOST.test(location.hostname) && LOCAL_PORTS.includes(location.port);
    if (!ok || window.top !== window) return;

    // One live copy per page: the background re-injects this file into open viewer tabs after an
    // install/reload. A superseded or orphaned copy stays SILENT (never answers), so it can't race
    // the live copy with an error reply.
    const me = {};
    window.__robflowBridge = me;
    const alive = () => window.__robflowBridge === me && !!(chrome.runtime && chrome.runtime.id);

    const FROM_EXT = 'robflow-clipper';
    const FROM_PAGE = 'orrerium';

    // Presence marker, set before any page script runs: the DOM is shared with the page (JS globals
    // are not), so the viewer can decide synchronously whether asking is worth it.
    document.documentElement.dataset.robflowClipper = chrome.runtime.getManifest().version;

    const post = (msg) => window.postMessage({ source: FROM_EXT, ...msg }, location.origin);

    window.addEventListener('message', (e) => {
        if (!alive() || e.source !== window || e.origin !== location.origin) return;
        const d = e.data;
        if (!d || d.source !== FROM_PAGE || d.type !== 'clipper:request') return;
        const id = typeof d.id === 'string' ? d.id : null;
        try {
            chrome.runtime.sendMessage({ type: 'get-session' }, (res) => {
                if (chrome.runtime.lastError || !res) {
                    post({ type: 'session', id, sid: null, token: null, reason: 'clipper background unavailable' });
                    return;
                }
                post({
                    type: 'session', id, sid: res.sid || null, token: res.token || null,
                    email: res.email || null, exp: res.exp || null, reason: res.reason || null,
                });
            });
        } catch {
            /* extension context gone mid-call: stay silent, the viewer times out */
        }
    });

    // Push: whenever the extension captures a fresher id token (Studio renewed it), hand it over.
    chrome.storage.onChanged.addListener((changes, area) => {
        const t = alive() && area === 'local' && changes.robflowToken && changes.robflowToken.newValue;
        if (t && t.value) post({ type: 'token', token: t.value, email: t.email || null, exp: t.exp || null });
    });
})();
