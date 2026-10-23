// Local preview WITHOUT the Netlify CLI:  npm run local   ->  http://localhost:8888
// Same API code as production; data is kept in .local-data/db.json instead of Netlify Blobs.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./netlify/functions/lib/core.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataFile = path.join(root, ".local-data", "db.json");
const PORT = process.env.PORT || 8888;

const data = new Map(fs.existsSync(dataFile) ? Object.entries(JSON.parse(fs.readFileSync(dataFile, "utf8"))) : []);
const persist = () => {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(Object.fromEntries(data)));
};
const store = {
  async get(k, o) { const v = data.get(k); return v === undefined ? null : o?.type === "json" ? JSON.parse(v) : v; },
  async set(k, v, o) { if (o?.onlyIfNew && data.has(k)) return { modified: false }; data.set(k, v); persist(); return { modified: true }; },
  async setJSON(k, v, o) { return this.set(k, JSON.stringify(v), o); },
  async delete(k) { data.delete(k); persist(); },
  async list({ prefix = "" } = {}) { return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
};

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }),
                           { store, env: process.env });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let rel = url.pathname.startsWith("/a/") ? "/attend.html" : url.pathname;
  if (rel === "/") rel = "/index.html";
  let file = path.join(publicDir, path.normalize(rel));
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": types[".html"] });
    return res.end(fs.readFileSync(path.join(publicDir, "404.html")));
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log(`Local preview: http://localhost:${PORT}  (admin / admin123)`));
