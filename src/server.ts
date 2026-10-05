import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { marked } from "marked";

const PORT = Number(process.env.PORT ?? 8080);

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

// Read fresh per request rather than at startup, so README.md's current
// content is always what's served, with no stale-cache or rebuild step.
function renderReadme(): string {
  const markdown = readFileSync("README.md", "utf8");
  const html = marked.parse(markdown, { async: false });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>README</title>
  </head>
  <body>
    ${html}
  </body>
</html>
`;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/" && req.method === "GET") {
    send(res, 200, "text/html; charset=utf-8", readFileSync("public/index.html", "utf8"));
    return;
  }

  if (url.pathname === "/readme/" && req.method === "GET") {
    send(res, 200, "text/html; charset=utf-8", renderReadme());
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "not found");
}

const server = createServer(handle);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}`);
});
