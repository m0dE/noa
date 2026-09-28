// Three fake sites for the wait_for end-to-end loop (test/e2e/wait-loop.mjs), on one local HTTP server that the
// browser reaches as http://inbox.test, http://app.test and http://builder.test (host-resolver-rules):
// - inbox.test: a message from someone saying a button does nothing, and a reply box (Send reply);
// - app.test/reports: the app with that bug (Export CSV does nothing) until a deploy fixes it;
// - builder.test: an app builder that takes a change request (Build & deploy) and, `deployMs` later, deploys it:
//   its page shows "Building..." and then "Deployed", updating itself, and the app's export works from then on.
import { createServer } from "node:http";

export const HOSTS = ["inbox.test", "app.test", "builder.test"];
export const MESSAGE = {
  from: "Dana Reyes",
  subject: "Export does nothing",
  text: "Hi, on the Reports page when I click Export CSV nothing happens at all. I need the file for a meeting tomorrow. Can you help?",
};

const page = (title, body, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;margin:24px;max-width:720px}textarea{width:100%;height:110px}.muted{color:#666}</style></head><body>${body}<script>${script}</script></body></html>`;

/** Starts the sites. Returns { port, state, close } (state: what happened, for the test's checks). */
export async function startWaitLoopSites({ deployMs }) {
  const state = { deployed: false, builds: [], replies: [], exports: [] };
  let deployTimer;
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => r(s ? JSON.parse(s) : {}));
  });
  const server = createServer(async (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url ?? "/", "http://x");
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (host === "inbox.test") {
      if (req.method === "POST" && url.pathname === "/api/reply") {
        const { text } = await readBody(req);
        state.replies.push({ text, at: Date.now() });
        return json(res, 200, { ok: true });
      }
      return html(
        page(
          "Support inbox - 1 open conversation",
          `<h1>Inbox</h1><article><h2>${MESSAGE.subject}</h2><p class="muted">From ${MESSAGE.from} &lt;dana@example.com&gt; · conversation #4821</p><p>${MESSAGE.text}</p></article>
<h3>Reply to ${MESSAGE.from}</h3><textarea id="reply" aria-label="Reply"></textarea><p><button id="send">Send reply</button></p><p id="sent"></p>`,
          `document.getElementById("send").onclick = async () => {
  const text = document.getElementById("reply").value;
  if (!text.trim()) return;
  await fetch("/api/reply", { method: "POST", body: JSON.stringify({ text }) });
  document.getElementById("sent").textContent = "Reply sent to Dana Reyes.";
  document.getElementById("reply").value = "";
};`,
        ),
      );
    }
    if (host === "app.test") {
      if (url.pathname === "/api/export") {
        state.exports.push({ deployed: state.deployed, at: Date.now() });
        return json(res, 200, { ok: state.deployed });
      }
      return html(
        page(
          "Reports - Acme Analytics",
          `<h1>Reports</h1><table><tr><th>Month</th><th>Revenue</th></tr><tr><td>August</td><td>$12,400</td></tr><tr><td>September</td><td>$13,950</td></tr></table>
<p><button id="export">Export CSV</button></p><p id="result"></p>`,
          // The bug: before the deploy the click does nothing visible at all.
          `document.getElementById("export").onclick = async () => {
  const r = await (await fetch("/api/export")).json();
  if (r.ok) document.getElementById("result").textContent = "Export ready: report.csv (2 rows) downloaded.";
};`,
        ),
      );
    }
    if (host === "builder.test") {
      if (req.method === "POST" && url.pathname === "/api/build") {
        const { text } = await readBody(req);
        state.builds.push({ text, at: Date.now() });
        clearTimeout(deployTimer);
        deployTimer = setTimeout(() => {
          state.deployed = true;
          state.deployedAt = Date.now();
        }, deployMs);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/status") {
        const last = state.builds.at(-1);
        return json(res, 200, { building: !!last && !state.deployed, deployed: state.deployed, since: last?.at ?? null });
      }
      return html(
        page(
          "App Builder",
          `<h1>App Builder</h1><p class="muted">Describe a change to your app. The builder writes the code and deploys it.</p>
<textarea id="prompt" aria-label="Describe the change"></textarea><p><button id="build">Build &amp; deploy</button></p><p id="status">No build running.</p>`,
          // The page keeps itself up to date, like a real builder's status line.
          `const status = document.getElementById("status");
document.getElementById("build").onclick = async () => {
  const text = document.getElementById("prompt").value;
  if (!text.trim()) return;
  await fetch("/api/build", { method: "POST", body: JSON.stringify({ text }) });
  status.textContent = "Building... this takes a few minutes.";
};
setInterval(async () => {
  const s = await (await fetch("/api/status")).json();
  if (s.deployed) status.textContent = "Deployed: version 2 is live.";
  else if (s.building) status.textContent = "Building... " + Math.round((Date.now() - s.since) / 1000) + " s so far.";
}, 2000);`,
        ),
      );
    }
    res.writeHead(404);
    res.end("unknown host");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const close = () =>
    new Promise((r) => {
      clearTimeout(deployTimer);
      server.closeAllConnections();
      server.close(() => r());
    });
  return { port: server.address().port, state, close };
}
