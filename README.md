# RobFlow Session Clipper

A Chrome extension that captures a live RobFlow virtual-robot session **and** the Cognito token
that authorizes control, and hands both to the robot viewer (Orrerium) and the RobCo Visual
Components add-on. No DevTools, no copy/paste, no page refresh after signing in.

## What it does

| | v1 | v2 | v3 |
|---|---|---|---|
| Session URL (SID) | ✅ copied to clipboard | ✅ captured | ✅ captured, follows new sessions |
| Cognito id token (control) | ❌ manual DevTools copy | ✅ after a tab refresh | ✅ right after sign-in, no refresh |
| Launch the viewer | ❌ paste into the dialog | ✅ token in the URL | ✅ viewer pulls the token itself |
| Token renewals reach the viewer | ❌ | ❌ | ✅ pushed to open viewer tabs |
| Control past the 1 h token lifetime | ❌ | ❌ | ✅ renewed automatically, even with Studio closed |
| Visual Components add-on | ❌ | ❌ | ✅ connected automatically (v3.1, see below) |

The session URL alone gives a **view-only** link. The Cognito id token is what unlocks
**control**: moving the robot, pushing/saving flows and reconfiguring modules.

## How it works

RobCo Studio keeps its login with `axios-jwt`: `{ accessToken, refreshToken }` as JSON in
`localStorage['auth-tokens-production']`. The `accessToken` is the Cognito id token Studio sends as
`Authorization: Bearer …` to `api.robco.studio`. After the Google redirect, Studio routes to the
session view with its SPA router, so there is no page load to hook. That is why v2 needed a
refresh.

- **`content.js`** runs on every `robco.studio` page. Every 2 s it reads Studio's stored tokens and
  the session iframe's SID, which catches the sign-in, Studio's own token renewals, session changes
  and sign-out. It passes the tokens to the background worker only, and injects an *Open in
  viewer* button on the session page.
- **`background.js`** (service worker) stores the freshest id token. It sleeps until something
  asks; it doesn't watch network traffic. Its sources are the content script and an on-demand
  read from any open Studio tab when a viewer asks and the stored token is stale. If nothing fresher is
  available, it renews the id token itself through Studio's own endpoint
  (`POST /public/login/refresh-token`), so a connected viewer stays in control past the hour. On
  install or reload it re-injects its scripts into already-open tabs. It derives the current SID
  from `/virtual-robot/status`.
- **`bridge.js`** runs on the viewer's origins: `orrerium.web.app`, `orrerium-develop.web.app`,
  the per-branch preview channels CI deploys (`orrerium--feat-<branch>-<hash>.web.app`), and `localhost`/`127.0.0.1` on the viewer's own ports only (3000 for
  `pnpm dev`, 4173 for `vite preview`), so another local server never gets the token. It marks the page with
  `<html data-robflow-clipper="<version>">`, answers the viewer's `postMessage` requests with the
  current SID and id token, and pushes fresher tokens as they arrive. The manifest matches
  `*.web.app` because preview channel hosts can't be listed. The script checks the hostname and
  stays inert everywhere else.
- **`desktop.js`** (part of the worker) hands the session to the RobCo Visual Components add-on.
  See [Visual Components](#visual-components) below.
- **`popup.js`** shows the session and token status (email, minutes left, where it came from) and
  the VC link, and opens the viewer.

## Visual Components

The RobCo VC add-on (repo `robco-vc-addon`) follows the same login, with nothing to paste into
its Connect field:

1. Whenever the extension's token changes, `desktop.js` sends it with the current session id to
   the add-on's helper through Chrome **native messaging** (host `com.robco.session_clipper`).
2. Chrome starts the helper (`clipper_native_host.py` on VC's Python) only for this extension's ID,
   which the manifest's `key` pins to `lcbedinbgcamhmjhenboamkmkkkfjigf`. The helper writes the token
   DPAPI-encrypted to `%LOCALAPPDATA%\RobCoVC\session_inbox.json` and exits. Nothing keeps
   listening between messages.
3. The add-on checks that file at most once a second on VC's own tick and adopts the token into
   its shared connection. Robots that follow the shared connection stay in control.
4. An alarm renews the token about 5 minutes before it expires, so VC stays connected with no
   viewer open. Signing out of Studio tells the add-on to drop the token.

Rules on the VC side: a lab stack or robot you connected to there is never overridden, and a
different account never replaces a live token. Only the 1 h id token reaches VC, never the
refresh token.

**Setup:** run the add-on's `install.ps1` (or *Update add-on.cmd*), which registers the helper for
Chrome and Edge under `HKCU`. The popup then shows a **Visual Components** row ("linked · updated
… ago"). Without the add-on installed, the extension tries the helper once per token change, finds
nothing, and arms no alarm.

## Install

### Load unpacked (for development)

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder

Chrome asks for access to `robco.studio`, `api.robco.studio`, `web.app` sites and `localhost`.
These are needed to read the Studio login, call RobCo's session and renewal endpoints, and talk
to the viewer. It also asks to communicate with cooperating native applications (the VC add-on's
helper).

**Upgrading from v3.0 or older:** v3.1 pins the extension ID (native messaging needs a fixed one),
so Chrome treats it as a new extension. Pull, then in `chrome://extensions` **remove** the old
*RobFlow Session Clipper* and **Load unpacked** the folder again. Its saved state (e.g. a custom
viewer URL) starts fresh once. Open Studio and viewer tabs pick it up without a refresh.

## Usage

1. Sign in at `robco.studio` (Google) and open a virtual robot session. You don't need to refresh.
2. Open the viewer (`orrerium.web.app`, or `localhost` in dev). With the extension installed it
   connects by itself, with control. Its Connect dialog also fills the token in automatically.
3. Or click the extension icon, or the on-page **Open in viewer** button. Launching also copies the
   fresh session URL (`…/session/<SID>/`) to your clipboard.

## Notes & limitations

- The id token lasts about 1 hour. When less than 6 minutes are left and a viewer asks (open viewers
  ask 5 minutes before expiry), the extension renews it with Studio's refresh token. Studio doesn't
  need to be open or used. Every renewal reaches open viewer tabs within seconds.
- **The refresh token** is held only in the worker's `chrome.storage.session`: memory-only (gone on
  a browser restart, after which one visit to robco.studio restores it) and unreadable by content
  scripts, pages and the viewer. It is only ever sent to RobCo's refresh endpoint. Signing out of
  Studio, or the endpoint rejecting it, clears it. RobCo returns the same refresh token on renewal
  (measured 2026-10-12), so renewing never signs Studio out. Should that change, the new pair is
  written back into open Studio tabs.
- Signing out of Studio doesn't revoke the refresh token on RobCo's side (Studio doesn't either).
  The extension stops using it once it sees the sign-out in an open Studio tab. A sign-out on
  another device isn't seen, so the extension keeps renewing until the browser closes or RobCo
  rejects the token.
- Only bridged viewer URLs get the token without it appearing in the URL. A custom viewer URL set
  in the popup falls back to `?robco=session&sid=…&token=…`.
- This automates an existing same-browser login. It is **not** a replacement login, and it still
  relies on a signed-in `robco.studio` session in the same browser.
