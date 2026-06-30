const SID_RE = /session\/(?:ws\/)?([^/?#]+)/;
const DEFAULT_VIEWER = 'https://orrerium.web.app';
const STATUS_URL = 'https://api.robco.studio/public/virtual-robot/status';
const SESSION_BASE = 'https://api.robco.studio/public/virtual-robot/session';
const sessionUrlFor = (sid) => `${SESSION_BASE}/${sid}/`;

const el = (id) => document.getElementById(id);
const sidValue = el('sidValue');
const tokenValue = el('tokenValue');
const openBtn = el('openBtn');
const viewerUrl = el('viewerUrl');
const copyUrlBtn = el('copyUrlBtn');
const copyTokenBtn = el('copyTokenBtn');
const statusDot = el('statusDot');
const statusHint = el('statusHint');

const state = { sid: null, sessionUrl: null, token: null };

const tokenLive = () => !!(state.token && state.token.exp && state.token.exp * 1000 > Date.now());
const minutesLeft = (exp) => (exp ? Math.max(0, Math.round((exp * 1000 - Date.now()) / 60000)) : null);

function viewerRoot() {
    return (viewerUrl.value.trim() || DEFAULT_VIEWER).replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function buildViewerUrl(sid) {
    const q = new URLSearchParams({ robco: 'session', sid });
    if (tokenLive()) q.set('token', state.token.value);
    return `${viewerRoot()}/?${q.toString()}`;
}

// The page-detected SID can go stale after a cloud session re-provisions; when we hold a live
// token, re-derive the current SID from /status (mirrors the viewer's own reload logic).
async function currentSid() {
    if (tokenLive()) {
        try {
            const res = await fetch(STATUS_URL, { headers: { Authorization: `Bearer ${state.token.value}` } });
            if (res.ok) {
                const data = await res.json();
                if (data && data.token) return data.token;
            }
        } catch {
            /* fall back to the stored SID */
        }
    }
    return state.sid;
}

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
        tokenValue.textContent = `${state.token.email || 'captured'} · ~${minutesLeft(state.token.exp)} min`;
        tokenValue.className = 'value ok';
    } else if (state.token) {
        tokenValue.textContent = `expired${state.token.email ? ` · ${state.token.email}` : ''}`;
        tokenValue.className = 'value warn';
    } else {
        tokenValue.textContent = 'not captured (view-only)';
        tokenValue.className = 'value empty';
    }

    const live = tokenLive();
    openBtn.disabled = !state.sid && !live;
    openBtn.textContent = live ? '▶ Open in viewer (control)' : '▶ Open in viewer (view-only)';
    copyUrlBtn.disabled = !state.sessionUrl;
    copyTokenBtn.disabled = !live;

    if (!state.sid && !live) {
        statusHint.textContent = 'Navigate to a RobFlow virtual robot session to auto-capture.';
    } else if (live) {
        statusHint.textContent = 'Ready — one click launches a live, controllable session.';
    } else {
        statusHint.textContent = 'Session found, but no live token — open robco.studio and stay signed in.';
    }
}

function loadState() {
    chrome.storage.local.get(['robflowSessionUrl', 'robflowToken', 'viewerBaseUrl'], (s) => {
        viewerUrl.value = s.viewerBaseUrl || '';
        state.token = s.robflowToken || null;

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabUrl = (tabs[0] && tabs[0].url) || '';
            const fromTab = tabUrl.startsWith('https://api.robco.studio/') && tabUrl.includes('/session/')
                ? tabUrl : null;
            state.sessionUrl = fromTab || s.robflowSessionUrl || null;
            const m = state.sessionUrl && state.sessionUrl.match(SID_RE);
            state.sid = m ? m[1] : null;
            render();
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
    const sid = await currentSid();
    if (!sid) {
        statusHint.textContent = 'Could not resolve a session — reopen the Studio session tab.';
        openBtn.disabled = false;
        return;
    }
    // Copy the fresh RobFlow session URL, then launch. Write (awaited) before opening the tab —
    // which steals focus — and before window.close(), so the clipboard write completes.
    const sessionUrl = sessionUrlFor(sid);
    try { await navigator.clipboard.writeText(sessionUrl); } catch { /* best-effort */ }
    chrome.storage.local.set({ robflowSessionUrl: sessionUrl }); // keep the stored URL fresh
    chrome.tabs.create({ url: buildViewerUrl(sid) });
    window.close();
});

copyUrlBtn.addEventListener('click', () => {
    if (!state.sessionUrl) return;
    navigator.clipboard.writeText(state.sessionUrl)
        .then(() => flash(copyUrlBtn, 'Copied ✓'))
        .catch(() => flash(copyUrlBtn, 'Failed'));
});

copyTokenBtn.addEventListener('click', () => {
    if (!tokenLive()) return;
    navigator.clipboard.writeText(state.token.value)
        .then(() => flash(copyTokenBtn, 'Copied ✓'))
        .catch(() => flash(copyTokenBtn, 'Failed'));
});

// Persist the viewer URL as the user edits it — only if it's a valid URL.
viewerUrl.addEventListener('change', () => {
    const v = viewerUrl.value.trim();
    if (v) {
        try { new URL(v); } catch { statusHint.textContent = 'Invalid viewer URL — not saved.'; return; }
    }
    chrome.storage.local.set({ viewerBaseUrl: v });
});

loadState();
