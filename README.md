# RobFlow Session Clipper

A Chrome extension that captures a live RobFlow virtual-robot session **and** the Cognito token
that authorizes control, then launches the viewer with a single click — no DevTools, no copy/paste.

## What it does

| | v1 | v2 |
|---|---|---|
| Session URL (SID) | ✅ copied to clipboard | ✅ captured |
| Cognito id token (control) | ❌ manual DevTools copy | ✅ auto-captured |
| Launch the viewer | ❌ paste into the dialog | ✅ one click → live session |

The session URL alone gives a **view-only** link. The Cognito id token (sent as
`Authorization: Bearer …` on every `api.robco.studio` request) is what unlocks **control** —
moving the robot and pushing/saving flows. v2 captures both and hands them to the viewer via its
`?robco=session&sid=…&token=…` entry point.

## How it works

- **`content.js`** (on `robco.studio/cloud-robflow*`) detects the session iframe → the SID, and
  reads the Cognito id token from page `localStorage` when present. Injects an *Open in viewer* button.
- **`background.js`** (service worker) observes outgoing `api.robco.studio` request headers and
  lifts the `Bearer` token — the exact header you used to copy by hand. It only ever **reads**
  headers; it never blocks or modifies any request. The freshest (latest-expiring) token wins.
- **`popup.js`** shows the session + token status (signed-in email, minutes remaining) and opens
  the viewer. The target viewer URL is editable (defaults to `https://orrerium.web.app`; set it to
  e.g. `http://localhost:5173` for local development).

## Install

### Load unpacked (for development)

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder

Chrome will ask to allow access to `api.robco.studio` — this is required to read the Bearer token
off RobFlow API traffic.

## Usage

1. Open a RobFlow session at `robco.studio/cloud-robflow` and stay signed in (Google).
2. Click the extension icon (or the on-page **Open in viewer** button).
3. The viewer opens already connected — controllable if a live token was captured, view-only otherwise.
   Launching also copies the **fresh session URL** (`…/session/<SID>/`) to your clipboard.

## Notes & limitations

- The Cognito id token lasts ~1 hour. The extension keeps the freshest one it sees; if it expires,
  trigger any action in the Studio tab (or refocus it) to mint a new one, then relaunch.
- **The token is passed in the viewer URL.** That's the viewer's documented entry point and is fine
  for an internal tool, but it does put a ~1 h bearer token in the new tab's address bar/history.
  If that matters, prefer the *Copy token* button + manual paste, or switch the handoff to a
  storage-injection content script on the viewer origin (see the viewer's `sessionStore` keys).
- This automates an existing same-origin token; it is **not** a replacement login. It still relies
  on a signed-in `robco.studio` session in the same browser.
