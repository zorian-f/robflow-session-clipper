const SESSION_PATTERN = /^https:\/\/api\.robco\.studio\/public\/virtual-robot\/session\/[^/]+/;

const urlDisplay = document.getElementById('urlDisplay');
const copyBtn = document.getElementById('copyBtn');
const statusDot = document.getElementById('statusDot');
const statusHint = document.getElementById('statusHint');

function setUrl(url) {
  urlDisplay.textContent = url;
  urlDisplay.classList.remove('empty');
  copyBtn.disabled = false;
  statusDot.classList.add('active');
  statusHint.textContent = 'Auto-copied on page load. Click to copy again.';
}

function setNoSession() {
  urlDisplay.textContent = 'Not on a session page';
  urlDisplay.classList.add('empty');
  copyBtn.disabled = true;
  statusDot.classList.remove('active');
  statusHint.textContent = 'Navigate to a RobFlow virtual robot session to auto-copy.';
}

// 1. Check current active tab URL first
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (tab && tab.url && SESSION_PATTERN.test(tab.url)) {
    const cleanUrl = tab.url.replace(/\/$/, '') + '/';
    setUrl(cleanUrl);
  } else {
    // 2. Fall back to stored URL from content script
    chrome.storage.session.get('robflowSessionUrl', (result) => {
      if (result.robflowSessionUrl) {
        setUrl(result.robflowSessionUrl);
        statusHint.textContent = 'Last detected session URL. Click to copy.';
      } else {
        setNoSession();
      }
    });
  }
});

// Copy button handler
copyBtn.addEventListener('click', () => {
  const url = urlDisplay.textContent;
  if (!url || copyBtn.disabled) return;

  navigator.clipboard.writeText(url).then(() => {
    copyBtn.textContent = 'Copied ✓';
    copyBtn.classList.add('success');
    setTimeout(() => {
      copyBtn.textContent = 'Copy to Clipboard';
      copyBtn.classList.remove('success');
    }, 2000);
  }).catch(() => {
    copyBtn.textContent = 'Failed — try again';
    setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
  });
});
