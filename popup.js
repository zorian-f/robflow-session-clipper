const SID_RE = /session\/(?:ws\/)?([^/?#]+)/;
const SESSION_BASE = 'https://api.robco.studio/public/virtual-robot/session';
const sessionUrlFor = (sid) => `${SESSION_BASE}/${sid}/`;
const SOURCE_LABEL = { 'studio-storage': 'Studio tab', 'studio-tab': 'Studio tab', renewed: 'auto-renewal' };

const el = (id) => document.getElementById(id);
const sidValue = el('sidValue');
const tokenValue = el('tokenValue');
const openBtn = el('openBtn');
const viewerUrl = el('viewerUrl');
const copyUrlBtn = el('copyUrlBtn');
const copyTokenBtn = el('copyTokenBtn');
const statusDot = el('statusDot');
const statusHint = el('statusHint');
const vcRow = el('vcRow');
const vcValue = el('vcValue');

const state = { sid: null, token: null, desktop: null };

const tokenLive = () => !!(state.token && state.token.exp && state.token.exp * 1000 > Date.now());
const minutesLeft = (exp) => (exp ? Math.max(0, Math.round((exp * 1000 - Date.now()) / 60000)) : null);

function render() {
    if (state.sid) {
        sidValue.textContent = `…${state.sid.slice(-8)}`;
        sidValue.classList.remove('empty');
        statusDot.classList.add('active');
    } else {
        sidValue.textContent = 'not detected';
        sidValue.classList.add('empty');
        statusDot.classList.remove('active');
    }

    if (state.token && tokenLive()) {
        const from = SOURCE_LABEL[state.token.source] ? ` · via ${SOURCE_LABEL[state.token.source]}` : '';
        tokenValue.textContent = `${state.token.email || 'captured'} · ~${minutesLeft(state.token.exp)} min${from}`;
        tokenValue.className = 'value ok';
    } else if (state.token) {
        tokenValue.textContent = `expired${state.token.email ? ` · ${state.token.email}` : ''}`;
        tokenValue.className = 'value warn';
    } else {
        tokenValue.textContent = 'not captured (view-only)';
        tokenValue.className = 'value empty';
    }

    // The VC add-on handoff (desktop.js): only shown once its helper has answered.
    vcRow.hidden = !state.desktop;
    if (state.desktop) {
        const ago = Math.max(0, Math.round((Date.now() - state.desktop.at) / 60000));
        vcValue.textContent = state.desktop.ok ? `linked · updated ${ago ? `${ago} min ago` : 'just now'}`
            : `helper error: ${state.desktop.error || 'unknown'}`;
        vcValue.className = state.desktop.ok ? 'value ok' : 'value warn';
    }

    const live = tokenLive();
    openBtn.disabled = !state.sid;
    openBtn.textContent = live ? '▶ Open in viewer (control)' : '▶ Open in viewer (view-only)';
    copyUrlBtn.disabled = !state.sid;
    copyTokenBtn.disabled = !live;

    if (!state.sid && !live) {
        statusHint.textContent = 'Sign in at robco.studio and open a virtual robot session. No refresh needed.';
    } else if (live) {
        statusHint.textContent = 'Ready. An open viewer tab picks this up by itself.';
    } else {
        statusHint.textContent = 'Session found, but no live token: open robco.studio and stay signed in.';
    }
}

/** Show what's stored right away, then refine with the background's fresh session (new SID, Studio-tab read). */
function loadState() {
    chrome.storage.local.get(['robflowSessionUrl', 'robflowToken', 'viewerBaseUrl', 'desktopSync'], (s) => {
        viewerUrl.value = s.viewerBaseUrl || '';
        state.token = s.robflowToken || null;
        state.desktop = s.desktopSync || null;
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            // A session opened directly (api.robco.studio/…/session/<SID>/) beats the stored one.
            const tabUrl = (tabs[0] && tabs[0].url) || '';
            const fromTab = tabUrl.startsWith(`${SESSION_BASE}/`) ? tabUrl : null;
            if (fromTab) await chrome.storage.local.set({ robflowSessionUrl: fromTab });
            state.sid = ((fromTab || s.robflowSessionUrl || '').match(SID_RE) || [])[1] || null;
            render();

            chrome.runtime.sendMessage({ type: 'get-session' }, (res) => {
                if (chrome.runtime.lastError || !res) return;
                if (res.sid) state.sid = res.sid;
                chrome.storage.local.get(['robflowToken', 'desktopSync'], ({ robflowToken, desktopSync }) => {
                    state.token = robflowToken || null;
                    state.desktop = desktopSync || null;
                    render();
                });
            });
        });
    });
}

function flash(btn, msg) {
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1600);
}

openBtn.addEventListener('click', async () => {
    if (openBtn.disabled) return;
    openBtn.disabled = true;
    // Copy the session URL BEFORE the new tab steals focus (the write needs a focused document).
    try { await navigator.clipboard.writeText(sessionUrlFor(state.sid)); } catch { /* best-effort */ }
    chrome.runtime.sendMessage({ type: 'open-viewer' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
            statusHint.textContent = (res && res.reason) || 'Could not open the viewer.';
            openBtn.disabled = false;
            return;
        }
        window.close();
    });
});

copyUrlBtn.addEventListener('click', () => {
    if (!state.sid) return;
    navigator.clipboard.writeText(sessionUrlFor(state.sid))
        .then(() => flash(copyUrlBtn, 'Copied ✓'))
        .catch(() => flash(copyUrlBtn, 'Failed'));
});

copyTokenBtn.addEventListener('click', () => {
    if (!tokenLive()) return;
    navigator.clipboard.writeText(state.token.value)
        .then(() => flash(copyTokenBtn, 'Copied ✓'))
        .catch(() => flash(copyTokenBtn, 'Failed'));
});

// Same rule as background.js isBridgedUrl(): where the viewer can pull the token itself.
function isBridged(u) {
    if (u.protocol === 'https:') return /^(?:orrerium(?:--feat-[a-z0-9-]+-[a-z0-9]{8})?|orrerium-develop)\.web\.app$/.test(u.hostname);
    return u.protocol === 'http:' && /^(?:localhost|127\.0\.0\.1)$/.test(u.hostname) && ['3000', '4173'].includes(u.port);
}

// Persist the viewer URL as the user edits it — only if it's a valid URL.
viewerUrl.addEventListener('change', () => {
    const v = viewerUrl.value.trim();
    let u = null;
    if (v) {
        try { u = new URL(v); } catch { statusHint.textContent = 'Invalid viewer URL, not saved.'; return; }
    }
    chrome.storage.local.set({ viewerBaseUrl: v });
    if (u && !isBridged(u)) {
        statusHint.textContent = `Saved. ${u.host} is not a known viewer, so the token goes in its URL. Only use a host you trust.`;
    }
});

loadState();
