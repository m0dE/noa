# Security

Noa drives a real, signed-in browser, so security reports matter a lot to us.

## Reporting a vulnerability

Please do not open a public issue. Report it privately, either:

- on GitHub: this repository's **Security** tab, **Report a vulnerability**, or
- by email to support@noa.bot, with "Security" in the subject.

Include what an attacker could do, the steps to reproduce it, and the Noa version (in
`chrome://extensions`). We reply as soon as we can and tell you when it is fixed. Please give us a
reasonable time to release a fix before you publish anything.

## Supported versions

Only the latest release (the Chrome Web Store version and this repository's `main`) gets fixes.

## In scope

The Chrome extension, the local helper, and the account server's API as the extension uses it
(`https://app.noa.bot`). Out of scope: attacks that need a malicious extension or full access to
your computer, and websites that Noa visits.
