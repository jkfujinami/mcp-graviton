#!/usr/bin/env node

import { FileSessionPersistence } from "./persistence";
import { ConfigurableApprovalStrategy } from "./approval";
import { GravitonEngine } from "./engine";
import { McpServerAdapter } from "./server";

async function main() {
  const persistence = new FileSessionPersistence();
  const defaultStrategy = new ConfigurableApprovalStrategy({
    runCommand: false,
    filePermission: false,
    openBrowserUrl: false,
  });

  const engine = new GravitonEngine(persistence, defaultStrategy);
  const server = new McpServerAdapter(engine);

  // Resume persisted pipelines from prior executions
  try {
    console.error("Restoring persistent graviton sessions...");
    await engine.resumeAllSavedSessions();
  } catch (e) {
    console.error("Failed to restore saved sessions:", e);
  }

  // Graceful shutdown handling
  const shutdown = async () => {
    console.error("\nShutting down mcp-graviton server gracefully...");
    try {
      await engine.shutdown();
      await server.stop();
      console.error("Shutdown finished successfully.");
      process.exit(0);
    } catch (e) {
      console.error("Error occurred during engine shutdown:", e);
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.start();
  } catch (e) {
    console.error("Fatal startup crash in MCP server:", e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unhandled fatal exception:", e);
  process.exit(1);
});
