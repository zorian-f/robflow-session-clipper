(() => {
    const SESSION_PATTERN = /^https:\/\/api\.robco\.studio\/public\/virtual-robot\/session\/[^"'\s/]+/;
    const SID_RE = /session\/(?:ws\/)?([^/?#]+)/;
    const STATUS_URL = 'https://api.robco.studio/public/virtual-robot/status';
    const DEFAULT_VIEWER = 'https://orrerium.web.app';
    // Amplify/Cognito keys the stored token by APP CLIENT id (not the pool id) — scope to RobCo's
    // client so we never pick up some other Cognito app's token that shares this origin.
    const COGNITO_CLIENT = '4gntu4bg8bim49i7edsjg981bq';
    const ID_TOKEN_KEY = new RegExp(`^CognitoIdentityServiceProvider\\.${COGNITO_CLIENT}\\..+\\.idToken$`);

    let detectedSid = false;
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

    // The SID embedded in the page can go stale when a cloud session is re-provisioned. When we
    // hold a live token, re-derive the CURRENT SID from /status — mirrors the viewer's own reload
    // logic (devLoad.restoreSavedSession). Falls back to the page-detected SID if the call fails.
    async function currentSid(token, fallbackSid) {
        if (token) {
            try {
                const res = await fetch(STATUS_URL, { headers: { Authorization: `Bearer ${token}` } });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.token) return data.token;
                }
            } catch {
                /* offline / expired — fall through */
            }
        }
        return fallbackSid;
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
            chrome.storage.local.get(['robflowSessionUrl', 'robflowToken', 'viewerBaseUrl'], async (s) => {
                const tok = s.robflowToken;
                const live = tok && tok.exp * 1000 > Date.now();
                const token = live ? tok.value : null;
                const stored = (s.robflowSessionUrl || '').match(SID_RE);
                const sid = await currentSid(token, stored ? stored[1] : null);
                if (!sid) { showToast('No session detected yet.', false); return; }
                if (!token) showToast('Opening view-only (no live control token).', false);
                window.open(buildViewerUrl(s.viewerBaseUrl, sid, token), '_blank', 'noopener');
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
