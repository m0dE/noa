import { createServer } from "node:http";

/**
 * A local HTTP server of HTML pages: page(path) returns (or resolves to) the HTML for a request's
 * path. Returns { base: "http://127.0.0.1:<port>", close }.
 */
export async function serveHtml(page) {
  const server = createServer(async (req, res) => {
    const html = await page(req.url ?? "/");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return { base: `http://127.0.0.1:${server.address().port}`, close };
}
