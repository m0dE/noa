// A sign-up page that waits for an email verification, and a fake mailbox with the
// verification email. For the "empty message looks at the page" checks: an agent that
// understands the page should open the mailbox, open the email and click its link.
//
//   /signup    "We sent a verification link to test@example.com. Open it to continue."
//              (shows "Email verified" once the link was opened)
//   /mail      the inbox of test@example.com (one unread email from Example App); on the
//              mail host (see `tls`) also at / and /mail/u/0/
//   /mail/1    that email, with the verification link (to this site's /verify)
//   /verify?token=...   the link: records the visit, shows "Email verified"
//   /state     JSON: { verified, visits } for the test
//
// email: the address the page names (default DEFAULT_EMAIL).
// tls: { key, cert } also serves the mailbox over https, so a browser started with
// --host-resolver-rules="MAP mail.google.com 127.0.0.1:<mailPort>" and
// --ignore-certificate-errors finds it where an agent looks for mail (https://mail.google.com).
//
// Usage: const s = await createVerifyEmailSite(); s.url("/signup"); s.state(); await s.close();
// Or run it: node test/fixtures/verify-email/server.mjs [port]
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";

export const TOKEN = "vrf-7Q2k9";
/** The address the sign-up page names by default (opts.email changes it). */
export const DEFAULT_EMAIL = "test@example.com";

const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
.card{border:1px solid #ddd;border-radius:10px;padding:20px 24px}.muted{color:#666}
a.btn{display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}
table{border-collapse:collapse;width:100%}td{padding:10px;border-bottom:1px solid #eee}tr.unread td{font-weight:600}</style>
</head><body>${body}</body></html>`;

export async function createVerifyEmailSite(port = 0, opts = {}) {
  const EMAIL = opts.email ?? DEFAULT_EMAIL;
  const state = { verified: false, visits: [] };
  let base = "";
  const handler = (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const host = String(req.headers.host ?? "");
    state.visits.push(`${host}${url.pathname}${url.search}`);
    // The mail host's own addresses for the inbox.
    if (opts.tls && !host.startsWith("127.0.0.1") && (url.pathname === "/" || url.pathname.startsWith("/mail/u/"))) url.pathname = "/mail";
    const html = (s) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(s);
    };
    switch (url.pathname) {
      case "/":
      case "/signup":
        return html(
          state.verified
            ? page("Example App - Verified", `<div class="card"><h1>Email verified</h1><p>Thanks, ${EMAIL} is verified. Your account is ready.</p></div>`)
            : page(
                "Example App - Check your email",
                `<div class="card"><h1>Check your email</h1>
<p>We sent a verification link to <b>${EMAIL}</b>. Open it to continue.</p>
<p class="muted">Didn't get it? Check your spam folder.</p></div>`,
              ),
        );
      case "/mail":
        return html(
          page(
            `Inbox (1) - ${EMAIL} - Mail`,
            `<h1>Inbox</h1><p class="muted">Signed in as ${EMAIL}</p>
<table><tr class="unread"><td>Example App</td><td><a href="/mail/1">Verify your email address</a></td><td>just now</td></tr>
<tr><td>Newsletter</td><td><a href="/mail/2">This week in gardening</a></td><td>Mon</td></tr></table>`,
          ),
        );
      case "/mail/1":
        return html(
          page(
            "Verify your email address - Mail",
            `<p><a href="/mail">&larr; Inbox</a></p><h1>Verify your email address</h1>
<p class="muted">From: Example App &lt;no-reply@example.com&gt; &middot; To: ${EMAIL}</p>
<p>Hi! Please confirm that this is your email address to finish signing up.</p>
<p><a class="btn" href="${base}/verify?token=${TOKEN}">Verify email</a></p>`,
          ),
        );
      case "/mail/2":
        return html(page("This week in gardening - Mail", `<p><a href="/mail">&larr; Inbox</a></p><h1>This week in gardening</h1><p>Tomatoes.</p>`));
      case "/verify":
        if (url.searchParams.get("token") === TOKEN) state.verified = true;
        return html(
          state.verified
            ? page("Example App - Email verified", `<div class="card"><h1>Email verified</h1><p>${EMAIL} is verified. You can go back to the sign-up page.</p></div>`)
            : page("Example App - Link expired", `<h1>This link is not valid</h1>`),
        );
      case "/state":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(state));
      default:
        res.writeHead(404).end();
    }
  };
  const server = createServer(handler);
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  let mail = null;
  if (opts.tls) {
    mail = createHttpsServer(opts.tls, handler);
    await new Promise((r) => mail.listen(0, "127.0.0.1", r));
  }
  return {
    base,
    email: EMAIL,
    /** The https port of the mailbox (with tls). */
    mailPort: mail?.address().port ?? null,
    url: (path) => `${base}${path}`,
    state: () => ({ verified: state.verified, visits: [...state.visits] }),
    close: () => Promise.all([server, mail].filter(Boolean).map((x) => new Promise((r) => x.close(() => r())))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await createVerifyEmailSite(Number(process.argv[2]) || 0);
  console.log(`sign-up page: ${s.url("/signup")}\nmailbox: ${s.url("/mail")}`);
}
