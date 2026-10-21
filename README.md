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
It runs in your own browser on your machine; see [Privacy](#privacy) for
what goes to the AI you pick.

Tasks can repeat on a schedule or run at a set time, which makes Noa a good
fit for social media: post, reply and check in on a routine without opening
the browser yourself.

You can also run Noa entirely by voice: start tasks, answer its questions
and hear results, hands-free. Pick from several voice engines, including
OpenAI's latest realtime voice model (gpt-realtime-2.1), a smaller realtime
model, Deepgram, or your browser's own voice. Voice runs through a Noa
account on a plan with voice ([pricing](https://www.noa.bot/pricing)).

Built for speed: Claude Code plans each task, and Jev, a fast model for
picking what to click and type, carries out the single steps, so a run
doesn't wait on a full Claude turn for every click.

Use the subscriptions you already have: your Claude plan through Claude
Code, or your own Claude API key, and your own Jev key. Without a Jev key,
a signed-in Noa account with usage credit uses Noa's hosted Jev; otherwise
Claude does each step itself.

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
   subscription, via a helper app; the page shows the install steps), the
   Claude API (your own key) or a local model (see below).
4. Sign in to your sites by hand in Chrome, then type a task in the side panel.

### A local model (Qwen, Hermes, ...)

Noa can run on a model on your own computer. One command sets it all up:

```sh
npx -y noa-local-llm
```

It installs the helper, [OpenCode](https://opencode.ai) (the open-source agent the helper runs the model on,
with web search, web pages and skills besides Noa's browser tools), [Ollama](https://ollama.com) if you have
none, and a model (`qwen3:8b`, or `--model`) with a context Noa's instructions fit in. Then in **Settings >
AI** pick **Local model** and click **Find models**. LM Studio (`:1234`), llama.cpp (`:8080`) and vLLM work
too: put their address in Settings. Details: [packages/local-llm](packages/local-llm/README.md).

How well it works depends on the model: small models often lose track of a
multi-step task.

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

## Privacy

Noa works in your own Chrome, with the logins you already have. Logins you
save under **Settings > Site logins** stay encrypted in the browser; when a
task has to sign in, Noa hands that one login to the AI. To decide each
step, it sends what is on the page to the AI that runs the task:

- **Local Claude Code** and the **Claude API** send it to Anthropic, under
  your own Claude plan or key.
- **A local model** keeps it on your computer (unless Jev is on).
- **Your own Jev key** sends single steps to Jev (TypeSafe) directly.
- **Noa AI**, Noa's **hosted Jev**, **voice**, and memory sync on a plan with
  the TODO list go through Noa's account server (`https://app.noa.bot`),
  only when you are signed in.

Details: [privacy policy](https://www.noa.bot/privacy) and
[terms](https://www.noa.bot/terms).

## Development

```
pnpm install
pnpm --filter @noa/extension exec playwright install chromium   # once, for the browser tests
pnpm typecheck
pnpm build
pnpm test
node apps/extension/test/smoke.e2e.mjs [--headed]
```

More end-to-end tests live in `apps/extension/test/`, and
`test/fixtures/fake-x` is a fake X site for testing.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report
security problems privately ([SECURITY.md](SECURITY.md)).

Automating a site may break its terms; check before you do. Not affiliated
with Anthropic, X or TypeSafe. Claude and Claude Code are trademarks of
Anthropic.

## License

MIT
