// MCP-level smoke test. Spawns dist/src/index.js as a child stdio process and
// talks JSON-RPC over its stdin/stdout exactly the way Claude / Codex would.
//
// Run: npm run mcp-smoke (after build)

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const serverPath = resolve(process.cwd(), "dist", "src", "index.js");
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map<number, (msg: any) => void>();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore non-JSON debug lines */ }
  }
});

function send<T = any>(method: string, params: any = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((res) => {
    pending.set(id, (msg) => res(msg as T));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method: string, params: any = {}): void {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`FAIL: ${msg}`); child.kill(); process.exit(1); }
  console.log(`  ok  — ${msg}`);
}

(async () => {
  console.log("Initializing MCP handshake…");
  const init: any = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "0.1" },
  });
  assert(init.result?.serverInfo?.name === "geogebra-mcp", "server identifies as geogebra-mcp");
  notify("notifications/initialized", {});

  const list: any = await send("tools/list", {});
  const tools = list.result?.tools ?? [];
  assert(tools.length >= 30, `tools/list returned ${tools.length} tools`);
  assert(tools.some((t: any) => t.name === "eval_command"), "eval_command present");
  assert(tools.some((t: any) => t.name === "cas_eval"), "cas_eval present");
  assert(tools.some((t: any) => t.name === "make_embed_html"), "make_embed_html present");

  const call: any = await send("tools/call", {
    name: "eval_command",
    arguments: { command: "f(x) = sin(x)" },
  });
  const text = call.result?.content?.[0]?.text ?? "";
  assert(text.includes("\"ok\": true"), `eval_command result: ${text}`);

  const png: any = await send("tools/call", {
    name: "export_png",
    arguments: { scale: 1, transparent: false },
  });
  const img = png.result?.content?.[0];
  assert(img?.type === "image" && img.mimeType === "image/png", "export_png returned image content");
  assert(typeof img.data === "string" && img.data.length > 1000, `PNG base64 length ${img.data.length}`);

  const embed: any = await send("tools/call", {
    name: "make_embed_html",
    arguments: { width: 600, height: 400 },
  });
  const html = embed.result?.content?.[0]?.text ?? "";
  assert(html.includes("deployggb.js"), "embed HTML includes deployggb.js");
  assert(html.includes("ggbBase64"), "embed HTML inlines ggbBase64 payload");

  console.log("\nAll MCP-level smoke checks passed.");
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error("MCP smoke crashed:", err);
  child.kill();
  process.exit(1);
});
