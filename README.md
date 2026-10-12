# RobFlow Session Clipper

A Chrome extension that captures a live RobFlow virtual-robot session **and** the Cognito token
that authorizes control, and hands both to the robot viewer (Orrerium). No DevTools, no copy/paste,
no page refresh after signing in.

## What it does

| | v1 | v2 | v3 |
|---|---|---|---|
| Session URL (SID) | ✅ copied to clipboard | ✅ captured | ✅ captured, follows new sessions |
| Cognito id token (control) | ❌ manual DevTools copy | ✅ after a tab refresh | ✅ right after sign-in, no refresh |
| Launch the viewer | ❌ paste into the dialog | ✅ token in the URL | ✅ viewer pulls the token itself |
| Token renewals reach the viewer | ❌ | ❌ | ✅ pushed to open viewer tabs |

The session URL alone gives a **view-only** link. The Cognito id token is what unlocks
**control**: moving the robot, pushing/saving flows and reconfiguring modules.

## How it works

RobCo Studio keeps its login with `axios-jwt`: `{ accessToken, refreshToken }` as JSON in
`localStorage['auth-tokens-production']`. The `accessToken` is the Cognito id token Studio sends as
`Authorization: Bearer …` to `api.robco.studio`. After the Google redirect, Studio routes to the
session view with its SPA router, so there is no page load to hook. That is why v2 needed a
refresh.

- **`content.js`** runs on every `robco.studio` page. Every 2 s it reads the stored id token and
  the session iframe's SID, which catches the sign-in, Studio's own token renewals and session
  changes. It injects an *Open in viewer* button on the session page. It never reads the refresh
  token.
- **`background.js`** (service worker) stores the freshest id token. Its sources are the content
  script, passive observation of `api.robco.studio` request headers (only from requests robco.studio
  itself initiates, so no other site can plant a token), and an on-demand read from any
  open Studio tab when a viewer asks and the stored token is stale. On install or reload it
  re-injects `content.js` into already-open Studio tabs. It derives the current SID from
  `/virtual-robot/status`.
- **`bridge.js`** runs on the viewer's origins: `orrerium.web.app`, `orrerium-develop.web.app`,
  the per-branch preview channels CI deploys (`orrerium--feat-<branch>-<hash>.web.app`), and `localhost`/`127.0.0.1` on the viewer's own ports only (3000 for
  `pnpm dev`, 4173 for `vite preview`), so another local server never gets the token. It marks the page with
  `<html data-robflow-clipper="<version>">`, answers the viewer's `postMessage` requests with the
  current SID and id token, and pushes fresher tokens as they arrive. The manifest matches
  `*.web.app` because preview channel hosts can't be listed. The script checks the hostname and
  stays inert everywhere else.
- **`popup.js`** shows the session and token status (email, minutes left, where it came from) and
  opens the viewer.

## Install

### Load unpacked (for development)

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder

Chrome asks for access to `robco.studio`, `api.robco.studio`, `web.app` sites and `localhost`.
These are needed to read the Studio login, observe API headers, and talk to the viewer.

**Upgrading from v2:** pull, then click the reload icon on the extension card in
`chrome://extensions`. v3 needs more site access than v2. If Chrome shows the extension as
disabled pending new permissions, re-enable it. Open Studio and viewer tabs pick up v3 without a
refresh.

## Usage

1. Sign in at `robco.studio` (Google) and open a virtual robot session. You don't need to refresh.
2. Open the viewer (`orrerium.web.app`, or `localhost` in dev). With the extension installed it
   connects by itself, with control. Its Connect dialog also fills the token in automatically.
3. Or click the extension icon, or the on-page **Open in viewer** button. Launching also copies the
   fresh session URL (`…/session/<SID>/`) to your clipboard.

## Notes & limitations

- The id token lasts about 1 hour. Studio renews it only while you use Studio, and every renewal
  reaches open viewer tabs within a few seconds. If Studio sits idle past the hour, the viewer keeps
  its live socket, but a reload falls back to view-only until Studio is used again.
- Only bridged viewer URLs get the token without it appearing in the URL. A custom viewer URL set
  in the popup falls back to `?robco=session&sid=…&token=…`.
- This automates an existing same-browser login. It is **not** a replacement login, and it still
  relies on a signed-in `robco.studio` session in the same browser.
