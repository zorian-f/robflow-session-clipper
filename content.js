(() => {
  const SESSION_PATTERN = /^https:\/\/api\.robco\.studio\/public\/virtual-robot\/session\/[^"'\s/]+/;

  let detected = false;

  function tryDetect() {
    if (detected) return true;

    const iframe = document.querySelector('iframe[src*="api.robco.studio/public/virtual-robot/session/"]');
    if (!iframe) return false;

    const match = iframe.src.match(SESSION_PATTERN);
    if (!match) return false;

    detected = true;
    const cleanUrl = match[0].replace(/\/$/, '') + '/';

    chrome.storage.local.set({ robflowSessionUrl: cleanUrl });

    navigator.clipboard.writeText(cleanUrl).then(() => {
      showToast('Session URL copied to clipboard!', true);
    }).catch(() => {
      showToast('Session URL detected (open popup to copy)', false);
    });

    return true;
  }

  function showToast(message, success) {
    const existing = document.getElementById('__robflow_toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = '__robflow_toast';
    toast.textContent = message;

    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '2147483647',
      background: success ? '#2c6e49' : '#636366',
      color: '#fff',
      padding: '10px 16px',
      borderRadius: '8px',
      fontSize: '13px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      opacity: '1',
      transition: 'opacity 0.5s ease',
      cursor: 'pointer',
      maxWidth: '320px',
      lineHeight: '1.4',
    });

    toast.addEventListener('click', () => toast.remove());
    document.body.appendChild(toast);

    setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    setTimeout(() => { toast.remove(); }, 3500);
  }

  // Try immediately (iframe may already be in DOM at document_idle)
  if (!tryDetect()) {
    // Vue renders the iframe dynamically — watch for it
    const observer = new MutationObserver(() => {
      if (tryDetect()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
  }
})();
