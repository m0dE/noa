<p align="center">
  <img src="brand/logo.svg" width="112" alt="Noa logo">
</p>

<h1 align="center">Noa</h1>

<p align="center">
  <a href="https://www.noa.bot">www.noa.bot</a> ·
  <a href="https://chromewebstore.google.com/detail/noa/enpgjinoecjfmomfkpjokgcledffmink">Get it on the Chrome Web Store</a>
</p>

A Chrome extension for browser automation, powered by Claude Code and Jev.
Give Noa a todo list and it works through each task in your own logged-in
Chrome (navigating, clicking, typing, uploading), then reports back.
Everything runs on your machine.

Tasks can repeat on a schedule or run at a set time, which makes Noa a good
fit for social media: post, reply and check in on a routine without opening
the browser yourself.

You can also run Noa entirely by voice: start tasks, answer its questions
and hear results, hands-free. Pick from several voice engines, including
OpenAI's latest realtime voice model (gpt-realtime-2.1), a smaller realtime
model, Deepgram, or your browser's own voice.

Built for speed: Claude Code plans each task, and Jev, a fast model for
picking what to click and type, carries out the single steps, so a run
doesn't wait on a full Claude turn for every click.

Use the subscriptions you already have: your Claude plan through Claude
Code, or your own Claude API key, and your own Jev key. Without a Jev key,
Noa uses its hosted Jev.

## Setup

The quickest way in is to install Noa from the
[Chrome Web Store](https://chromewebstore.google.com/detail/noa/enpgjinoecjfmomfkpjokgcledffmink),
then follow steps 3 and 4. To build it from source instead (requires Chrome,
Node.js 22+ and pnpm 10):

1. Build: `pnpm install && pnpm build`
2. In `chrome://extensions`, turn on Developer mode, click "Load unpacked" and
   pick the repo's `dist` folder.
3. Open the extension's settings, go to **AI** and pick where the AI comes
   from: Noa AI (hosted, needs an account), Local Claude Code (your Claude
   subscription, via a helper app; the page shows the install steps) or the
   Claude API (your own key).
4. Sign in to your sites by hand in Chrome, then type a task in the side panel.

### The helper (Local Claude Code)

Local Claude Code needs a small helper that connects Chrome to Claude Code.
Settings shows a one-line install command for your system:

- macOS and Linux, in Terminal: `curl -fsSL https://noa.bot/helper/install.sh | sh`
- Windows, in PowerShell: `irm https://noa.bot/helper/install.ps1 | iex`

From a source build, run `node apps/helper/dist/install.js` instead. If
Settings says the helper is out of date, run the same command again (or
rebuild) and click **Re-check**.

## Usage

Type a task in the side panel to start it. Every chat, scheduled task and
past run shows up as a job: **Home** groups them by what needs you, what's
running and what's coming up; **Scheduled** lists repeating and timed tasks.
How often Noa asks before acting is set under **Settings > Permission**.

Chrome shows an "is debugging this browser" bar during runs; closing it stops
all tasks.

To drive the browser from your own Claude Code:

```
claude mcp add noa -- node <path-to-repo>/apps/helper/dist/mcp-server.js --attach
```

An optional account server can queue tasks for the extension to run; see
[the protocol](docs/PROTOCOL.md).

## Development

```
pnpm test
pnpm typecheck
pnpm build
node apps/extension/test/smoke.e2e.mjs [--headed]
```

More end-to-end tests live in `apps/extension/test/`, and
`test/fixtures/fake-x` is a fake X site for testing.

Automating a site may break its terms; check before you do. Not affiliated
with Anthropic, X or TypeSafe. Claude and Claude Code are trademarks of
Anthropic.

## License

MIT
