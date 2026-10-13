# Contributing

Thanks for helping with Noa. Bug reports, ideas and pull requests are all welcome.

## How this repository works

This repository is published from Noa's private repository, which also holds the hosted account
server and the website. Each release replaces the files here with the private repository's copy,
so a pull request is not merged here directly: a maintainer applies it in the private repository,
credits you, and it arrives here with the next release. Your pull request is closed with a link
to that change.

## Before you open a pull request

1. Install and build: `pnpm install && pnpm build` (Node.js 22+, pnpm 10).
2. For the browser tests, install Playwright's Chromium once:
   `pnpm --filter @noa/extension exec playwright install chromium`
3. Run `pnpm typecheck` and `pnpm test`. CI runs the same.
4. Keep a change to one thing, and add or update a test for it.

## Reporting bugs

Open an issue with the bug report form: what you asked Noa to do, what it did, and which AI you
use (Noa AI, Local Claude Code or the Claude API). A screenshot of the run helps. Leave out
passwords, API keys and anything personal from the pages Noa worked on.

Security problems go privately, not in an issue: see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE),
and you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
