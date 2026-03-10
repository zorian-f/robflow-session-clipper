(() => {
  const SESSION_PATTERN = /^https:\/\/api\.robco\.studio\/public\/virtual-robot\/session\/[^/]+/;

  const sessionUrl = window.location.href;

  if (!SESSION_PATTERN.test(sessionUrl)) return;

  // Normalise: strip trailing slash variations but keep clean
  const cleanUrl = sessionUrl.replace(/\/$/, '') + '/';

  // Store for popup access
  chrome.storage.session.set({ robflowSessionUrl: cleanUrl });

  // Auto-copy to clipboard
  navigator.clipboard.writeText(cleanUrl).then(() => {
    showToast('Session URL copied to clipboard!', true);
  }).catch(() => {
    // Clipboard write can fail if page isn't focused — show URL anyway
    showToast('Session URL detected (open popup to copy)', false);
  });

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

    // Fade out after 3 s, remove after fade
    setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    setTimeout(() => { toast.remove(); }, 3500);
  }
})();
