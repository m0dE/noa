# Noa

Noa is like Claude Code, for your browser. Give it a todo list and it
works through each task in your own logged-in Chrome: it navigates, reads the
page, clicks, types, scrolls, takes screenshots and uploads images or video,
then reports back. It was built to catch up on social posting, like three
posts a day on each of three X accounts, and it works for anything else you
do in Chrome.

It runs entirely on your machine. A cloud task queue is optional.

## What you get

- **A side panel** (click the toolbar icon) with three tabs:
  - **Chat:** the conversation with the agent, live: which brain and model
    run it, what Claude says, every tool call and result, and Jev's picks.
    The bar above it has **New Chat** (start over), **Show Tab** (bring up
    the tab the agent is using while it works) and **Raw Log** (the helper's
    full log of a Claude Code run). **Each browser tab has its own chat:**
    switch tabs and the panel shows that tab's conversation (or an empty new
    chat). Chats running in other tabs show as chips; click one to go to its
    tab.
  - **TODO:** a todo list with times, daily repeats and attached files.
    "Run now" runs the tasks whose time has come without waiting for the
    next check. Hover a status chip to see what it means.
  - **Activity Log:** every past run; open one to read it, and "Open in
    Chat" to continue it.
- **A message box** under Chat and TODO:
  - Type a task to start it now.
  - While a task runs, your message goes straight to the agent. Stop pauses
    it.
  - After a task ends, a message continues the same conversation. If the
    agent session is still open (up to 30 idle minutes) it picks the message
    up; otherwise a fresh one starts with a summary of what was done.
  - A run that was stopped, paused or failed shows a **Continue** button.
  - **New Chat** ends this tab's conversation; the next message starts a
    new one. Other tabs keep theirs.
  - The **model chip** shows the model and whether Jev is on, and changes
    either.
- **A settings page** for the brain, the model, keys, cloud sync, site
  logins and limits.
- **Careful defaults:**
  - It pauses at login pages, 2FA, CAPTCHAs and account warnings.
  - It never types your X password.
  - It checks each X post exists before calling the task done.
  - A retry after a crash checks for an existing post before posting again.
  - Scheduled runs stop after repeated failures.

## Choose a brain

| Option | You need | Notes |
|---|---|---|
| **Claude API** | An Anthropic API key | Runs inside the extension. Nothing else to install. |
| **Local Claude Code** | Claude Code installed and signed in, plus the helper below | Uses your Claude subscription. Runs headless, with only Noa's browser tools. |
| **Auto** (default) | Either of the above | Uses local Claude Code when the helper works, otherwise the API key. |

The model setting (default Sonnet 5) applies to both brains.

**Jev is optional with either brain.** With a Jev key, steps can be described
in plain words ("click the Post button") and a small, fast model finds the
element. Without it, Claude names the element from the page's element list.
Either way, Claude sends several steps in one call. On a fake X site with
real Claude Code, a post took 19.6 s on average before steps were batched,
16.4 s with batched steps, and 15.3 s with batched steps and Jev (6 posts
each).

## Setup

Requirements: Google Chrome, Node.js 22+ and pnpm 10 to build. The helper
for local Claude Code runs on Windows, macOS and Linux.

1. **Build it.**

   ```
   pnpm install
   pnpm build
   ```

2. **Load the extension.** Open `chrome://extensions`, turn on Developer mode,
   click "Load unpacked", and pick the `dist` folder at the root of this
   repository.

3. **Pick a brain** in the extension's settings: paste an Anthropic API key,
   or register the helper for local Claude Code:

   ```
   node apps/helper/dist/install.js
   ```

   Then click "Connect" under the helper status. The first connection runs a
   short Claude Code self-test. `--uninstall` removes the registration.
   Signing in to Claude Code alone is not enough: Chrome reaches Claude Code
   only through the registered helper. On macOS and Linux, run the installer
   from a terminal where `claude` works: the helper keeps that PATH.

4. **Optional:** add a Jev key in settings.

5. **Sign in to your accounts by hand** in Chrome. For several X accounts, use
   X's "Add an existing account" so they all appear in X's account switcher.

6. **Type a task** in the side panel's message box and click Run.

## How it works in your browser

- **It uses your own tabs.** A task you start from the side panel works in
  that tab, and keeps working there if you switch to another tab (or in a
  new tab next to it, if that tab is a browser page or already in use; the
  chat then moves to the new tab). Two tabs can each run their own chat at
  the same time. Closing a tab stops its chat's task; the run stays in the
  Activity Log, where "Open in Chat" puts it in the current tab. Scheduled
  tasks use their own tab. Agent tabs go in a tab group named "Noa".
- **Scrolling reports what moved:** how many pixels and where the page is
  now, or that nothing moved (already at the bottom, or that part of the
  page does not scroll).
- **Several tasks at once.** Up to 2 due tasks run at the same time by
  default (up to 4, "Tasks at once" in settings), each in its own tab, and
  tasks you start from the side panel run beside them. Tasks on X run one at
  a time, because all X accounts share one login in the browser: switching
  accounts in one tab switches it in every tab.
- **Several pages at once.** The agent can open up to 8 pages in parallel
  tabs and read them in one step. Opening and reading 5 test pages took
  4.8 s one by one and 0.5 s in parallel tabs. Tabs it opens are closed when
  the task ends.
- **Chrome shows an "is debugging this browser" bar** while a task runs. That
  is how the extension sends real clicks and keystrokes. Closing the bar
  stops every running task.
- **Pages with another extension inside them** (for example Streak in
  Gmail) block Chrome's debugger. On those pages the extension falls back to
  simulated clicks and typing. Some sites ignore simulated input, and files
  cannot be uploaded there.

## Use the browser tools from your own terminal

With the helper registered and Chrome open, your regular Claude Code can drive
the browser too:

```
claude mcp add noa -- node <path-to-repo>/apps/helper/dist/mcp-server.js --attach
```

Then ask Claude Code something like "post this on X from @me". It gets the
same tools as tasks, except the ones that end a task. While a Noa
task is running, its calls are turned away until the task finishes.

## Cloud task queue (optional)

Turn on Cloud sync in settings and enter a task server URL and runner key.
The extension then also takes tasks from that server, so another app can
queue work while your computer is off. Any server that implements
[the protocol](docs/PROTOCOL.md) works.

## Settings

| Setting | Default |
|---|---|
| Check for due tasks | every 15 minutes |
| Random pause between tasks | 60–180 seconds |
| Maximum tool calls per task | 60 |
| Maximum time per task | 10 minutes |
| Tasks at once | 2 (1–4; X tasks one at a time) |
| Retry a temporary failure after | 10 minutes |
| Retry a task that needed you after | 15 minutes |
| Pause runs after failures in a row | 3 |

**Site logins** stores usernames and passwords for other sites, encrypted
with a passphrase you enter once per browser session. The agent asks for the
login of the site it is signing in to, and the username and password go to
Claude. It is never used for X. The passphrase can't be recovered: if you
forget it, **Forgot passphrase?** erases the saved logins so you can start
over with a new one.

Every run is kept in the side panel's Activity Log, for both brains. With the
helper, each Claude Code run also has a full log in
`%LOCALAPPDATA%\noa\runs\`.

## Things to know

- **Sites change their pages.** Account switching on X relies on X's current
  page structure. If it breaks, Claude falls back to finding the menu itself.
- **Automation may break a site's rules.** Check the terms of any site you
  automate.
- **Page content is untrusted.** The agent follows your instructions, not text
  it finds on a page. What it reads on a page is sent to Claude.

## Development

```
pnpm test
pnpm typecheck
pnpm build
node apps/extension/test/smoke.e2e.mjs [--headed]           # the built extension in Playwright's Chromium
node apps/extension/test/multitab.e2e.mjs [--headed]        # parallel tabs vs one by one
node apps/extension/test/foreign-frame.e2e.mjs [--headed]   # the fallback on pages with another extension's frame
node apps/extension/test/tabs.e2e.mjs [--headed]            # a chat per tab: two tabs running at once, the panel following the tab
node apps/extension/test/ui/harness.mjs [--headed]          # side panel and settings screenshots, light and dark
```

`test/fixtures/fake-x` is a small fake X site, with an account switcher, a
composer, image upload and a lock page, for testing without touching the
real site.

Not affiliated with Anthropic, X or TypeSafe. Claude and Claude Code are
trademarks of Anthropic.

## License

MIT
