#!/usr/bin/env node
// geogebra-mcp — Model Context Protocol server exposing GeoGebra construction,
// CAS, export, and .ggb state tools over stdio.
//
// Compatible with Claude Desktop, Claude Code, Cowork mode, and Codex CLI.
//
// Usage (from any MCP client config):
//   "command": "npx",  "args": ["-y", "@tiosavich/geogebra-mcp"]
// or, after installing globally:
//   "command": "geogebra-mcp"

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GeoGebraDriver, type GgbApp } from "./geogebra.js";
import { ALL_TOOLS } from "./tools.js";

// We avoid hard-depending on zod-to-json-schema by inlining a small converter
// that handles the shapes we use. But zod-to-json-schema is a tiny, audited
// utility and is the path of least surprise — importing it here.

async function main(): Promise<void> {
  const initialApp = (process.env.GEOGEBRA_APP as GgbApp | undefined) ?? "suite";
  const headless = process.env.GEOGEBRA_HEADLESS !== "false";
  const codebase = process.env.GEOGEBRA_CODEBASE;

  const driver = new GeoGebraDriver({ app: initialApp, headless, codebase });

  const server = new Server(
    { name: "geogebra-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema, { $refStrategy: "none" }) as any,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = ALL_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(args as any, driver);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error in ${tool.name}: ${msg}` }],
        isError: true,
      };
    }
  });

  // Graceful shutdown so the headless Chromium doesn't get orphaned.
  const shutdown = async () => {
    try { await driver.stop(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Eager-start the driver so the first tool call is snappy. If start fails
  // we exit so the MCP client can show a clean error.
  try {
    await driver.start();
  } catch (err) {
    process.stderr.write(`Failed to start GeoGebra driver: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
