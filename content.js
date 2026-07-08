(() => {
    const SESSION_PATTERN = /^https:\/\/api\.robco\.studio\/public\/virtual-robot\/session\/[^"'\s/]+/;
    const SID_RE = /session\/(?:ws\/)?([^/?#]+)/;
    const DEFAULT_VIEWER = 'https://orrerium.web.app';
    // Amplify/Cognito keys the stored token by APP CLIENT id (not the pool id) — scope to RobCo's
    // client so we never pick up some other Cognito app's token that shares this origin.
    const COGNITO_CLIENT = '4gntu4bg8bim49i7edsjg981bq';
    const ID_TOKEN_KEY = new RegExp(`^CognitoIdentityServiceProvider\\.${COGNITO_CLIENT}\\..+\\.idToken$`);

    let detectedSid = false;
    let lastSessionUrl = null;
    let lastCaptureAt = 0;

    // --- SID detection (the session iframe) ----------------------------------------------------
    function tryDetectSid() {
        if (detectedSid) return true;
        const iframe = document.querySelector('iframe[src*="api.robco.studio/public/virtual-robot/session/"]');
        if (!iframe) return false;
        const match = iframe.src.match(SESSION_PATTERN);
        if (!match) return false;

        detectedSid = true;
        const cleanUrl = match[0].replace(/\/$/, '') + '/';
        lastSessionUrl = cleanUrl;
        chrome.storage.local.set({ robflowSessionUrl: cleanUrl });
        showToast('RobFlow session captured — open the popup to launch the viewer.', true);
        ensureLaunchButton();
        return true;
    }

    // --- Token detection (Cognito id token in page localStorage) -------------------------------
    // A no-network, on-demand source that complements the background webRequest capture. The
    // content script shares robco.studio's origin, so it can read Amplify/Cognito's stored token.
    function readTokenFromStorage() {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && ID_TOKEN_KEY.test(k)) return localStorage.getItem(k);
            }
        } catch {
            /* storage blocked */
        }
        return null;
    }

    // Minimal JWT decode (no verification) — just enough to gate on expiry + token_use.
    function decodeJwtLite(token) {
        try {
            const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return { exp: p.exp || 0, use: p.token_use || null };
        } catch {
            return null;
        }
    }

    // The freshest LIVE Cognito id token straight from the page, or null. Content scripts share
    // robco.studio's origin, so this bypasses the focus-throttled / background-cached copy and hands
    // the launch the most current credential.
    function liveIdTokenFromPage() {
        const t = readTokenFromStorage();
        if (!t) return null;
        const d = decodeJwtLite(t);
        if (!d || d.use !== 'id' || d.exp * 1000 <= Date.now()) return null;
        return t;
    }

    function captureStorageToken() {
        if (Date.now() - lastCaptureAt < 60000) return; // throttle refocus spam
        const token = readTokenFromStorage();
        if (token) {
            lastCaptureAt = Date.now();
            chrome.runtime.sendMessage({ type: 'capture-token', token });
        }
    }

    // --- One-click "Open in viewer" injected onto the Studio page ------------------------------
    function buildViewerUrl(base, sid, token) {
        const root = (base || DEFAULT_VIEWER).replace(/[?#].*$/, '').replace(/\/+$/, '');
        const q = new URLSearchParams({ robco: 'session', sid });
        if (token) q.set('token', token);
        return `${root}/?${q.toString()}`;
    }

    function ensureLaunchButton() {
        if (document.getElementById('__robflow_launch')) return;
        const btn = document.createElement('button');
        btn.id = '__robflow_launch';
        btn.textContent = '▶ Open in viewer';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
            background: '#2c6e49', color: '#fff', border: '0', borderRadius: '8px',
            padding: '10px 16px', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        });
        btn.addEventListener('click', () => {
            if (!lastSessionUrl) { showToast('No session detected yet.', false); return; }
            const sid = (lastSessionUrl.match(SID_RE) || [])[1];
            if (!sid) { showToast('Malformed session URL — reload the session tab.', false); return; }
            // Read the freshest live id token straight from the page and hand it to the background so
            // its stored copy (the popup's source) stays current too — this way the handoff carries
            // BOTH the session and a live control token whenever the user is signed in.
            const pageToken = liveIdTokenFromPage();
            if (pageToken) chrome.runtime.sendMessage({ type: 'capture-token', token: pageToken });
            // Fire the clipboard write synchronously inside the click gesture (best chance of success
            // in the page context), then report the REAL result rather than assuming it copied —
            // a page Permissions-Policy or lost focus can still reject it.
            let copied;
            try {
                copied = navigator.clipboard.writeText(lastSessionUrl).then(() => true, () => false);
            } catch {
                copied = Promise.resolve(false);
            }
            chrome.storage.local.get(['robflowToken', 'viewerBaseUrl'], (s) => {
                const stored = s.robflowToken && s.robflowToken.exp * 1000 > Date.now() ? s.robflowToken.value : null;
                const token = pageToken || stored; // prefer the just-read page token
                const mode = token ? 'control' : 'view-only';
                window.open(buildViewerUrl(s.viewerBaseUrl, sid, token), '_blank', 'noopener');
                copied.then((ok) => showToast(
                    ok ? `Session URL copied — opened viewer (${mode}).`
                       : `Opened viewer (${mode}) — clipboard copy was blocked.`, ok));
            });
        });
        document.body.appendChild(btn);
    }

    function showToast(message, success) {
        const existing = document.getElementById('__robflow_toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = '__robflow_toast';
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '70px', right: '24px', zIndex: '2147483647',
            background: success ? '#2c6e49' : '#636366', color: '#fff', padding: '10px 16px',
            borderRadius: '8px', fontSize: '13px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)', opacity: '1',
            transition: 'opacity 0.5s ease', cursor: 'pointer', maxWidth: '320px', lineHeight: '1.4',
        });
        toast.addEventListener('click', () => toast.remove());
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 3000);
        setTimeout(() => { toast.remove(); }, 3500);
    }

    // Capture the token now and whenever the tab regains focus (it rotates ~hourly).
    captureStorageToken();
    window.addEventListener('focus', captureStorageToken);

    // Detect the SID immediately, then watch for Vue rendering the iframe in late.
    if (!tryDetectSid()) {
        const observer = new MutationObserver(() => {
            if (tryDetectSid()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 60000);
    }
})();
