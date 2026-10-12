(() => {
    // Runs on EVERY robco.studio page (not just /cloud-robflow): after the Google redirect Studio
    // routes from /login to the session view with the SPA router — no page load — so a script
    // scoped to /cloud-robflow was never injected until a manual refresh.
    //
    // Re-injection guard: after an extension install/reload the background injects this file into
    // already-open Studio tabs. The orphaned previous copy notices it was superseded (or that its
    // extension context is gone) on its next tick and stops.
    const me = {};
    const INSTANCE = Math.random().toString(36).slice(2);
    window.__robflowClipper = me;
    const alive = () => window.__robflowClipper === me && !!(chrome.runtime && chrome.runtime.id);

    const SESSION_PATTERN = /^https:\/\/api\.robco\.studio\/public\/virtual-robot\/session\/[^"'\s/]+/;
    // Studio uses axios-jwt: { accessToken, refreshToken } as JSON under this key. The accessToken
    // is the Cognito id token. We only ever read accessToken.
    const STUDIO_TOKENS_KEY = 'auth-tokens-production';
    // Cheap (one localStorage read + one querySelector) and catches the login, token renewals and
    // session changes within a couple of seconds. The storage event can't be used: it never fires
    // for writes made by the same document.
    const POLL_MS = 2000;

    let lastToken = null;
    let lastSessionUrl = null;

    // --- Token (Studio's own localStorage) -----------------------------------------------------
    function readStudioToken() {
        try {
            const tokens = JSON.parse(localStorage.getItem(STUDIO_TOKENS_KEY) || 'null');
            return tokens && typeof tokens.accessToken === 'string' ? tokens.accessToken : null;
        } catch {
            return null; // storage blocked or not JSON
        }
    }

    let sending = false;
    function pollToken() {
        const token = readStudioToken();
        if (!token || token === lastToken || sending) return;
        sending = true;
        // Only mark it sent once the worker took it (it may be starting up); else retry next tick.
        chrome.runtime.sendMessage({ type: 'capture-token', token }, () => {
            sending = false;
            if (!chrome.runtime.lastError) lastToken = token;
        });
    }

    // --- SID (the session iframe; follows a new session in the same tab) -----------------------
    function pollSession() {
        const iframe = document.querySelector('iframe[src*="api.robco.studio/public/virtual-robot/session/"]');
        const match = iframe && iframe.src.match(SESSION_PATTERN);
        setLaunchButton(!!match);
        if (!match) return;
        const url = match[0].replace(/\/$/, '') + '/';
        if (url === lastSessionUrl) return;
        const first = lastSessionUrl === null;
        lastSessionUrl = url;
        chrome.storage.local.set({ robflowSessionUrl: url });
        showToast(first ? 'RobFlow session captured. Open it in the viewer from here or the popup.'
                        : 'New RobFlow session captured.', true);
    }

    // --- One-click "Open in viewer" on the session page ----------------------------------------
    function setLaunchButton(show) {
        let btn = document.getElementById('__robflow_launch');
        if (!show) { if (btn) btn.remove(); return; }
        if (btn && btn.dataset.owner === INSTANCE) return;
        if (btn) btn.remove(); // a superseded copy's button, its click handler is dead
        btn = document.createElement('button');
        btn.id = '__robflow_launch';
        btn.dataset.owner = INSTANCE;
        btn.textContent = '▶ Open in viewer';
        Object.assign(btn.style, {
            position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
            background: '#2c6e49', color: '#fff', border: '0', borderRadius: '8px',
            padding: '10px 16px', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        });
        btn.addEventListener('click', onLaunch);
        document.body.appendChild(btn);
    }

    function onLaunch() {
        if (!alive()) { showToast('The clipper was reloaded. Refresh this tab once.', false); return; }
        // Clipboard write fires synchronously inside the click gesture (best chance in the page
        // context); report the REAL result — a Permissions-Policy or lost focus can still reject it.
        let copied;
        try {
            copied = lastSessionUrl
                ? navigator.clipboard.writeText(lastSessionUrl).then(() => true, () => false)
                : Promise.resolve(false);
        } catch {
            copied = Promise.resolve(false);
        }
        // The background opens the tab (no popup blocker) with a freshly derived SID.
        chrome.runtime.sendMessage({ type: 'open-viewer' }, (res) => {
            if (chrome.runtime.lastError || !res || !res.ok) {
                showToast((res && res.reason) || 'Could not open the viewer.', false);
                return;
            }
            const mode = res.control ? 'control' : 'view-only';
            copied.then((ok) => showToast(
                ok ? `Session URL copied. Opened viewer (${mode}).`
                   : `Opened viewer (${mode}). Clipboard copy was blocked.`, ok));
        });
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

    function tick() {
        if (!alive()) { clearInterval(timer); return; }
        // Isolated so a DOM hiccup in one can't stop the other; a throw from an invalidated
        // extension context is caught here and ends the loop via alive() on the next tick.
        try { pollToken(); } catch { sending = false; }
        try { pollSession(); } catch { /* retried next tick */ }
    }

    const timer = setInterval(tick, POLL_MS);
    tick();
})();
