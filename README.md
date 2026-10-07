# Noa

Claude Code for your browser. Give Noa a todo list and it works through each
task in your own logged-in Chrome (navigating, clicking, typing, uploading),
then reports back. Everything runs on your machine.

## Setup

Requires Chrome, Node.js 22+ and pnpm 10.

1. Build: `pnpm install && pnpm build`
2. In `chrome://extensions`, turn on Developer mode, click "Load unpacked" and
   pick the repo's `dist` folder.
3. Open the extension's settings, go to **AI** and pick where the AI comes
   from: Noa AI (hosted, needs an account), Local Claude Code (your Claude
   subscription, via a helper app; the page shows the install steps) or the
   Claude API (your own key).
4. Sign in to your sites by hand in Chrome, then type a task in the side panel.

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
