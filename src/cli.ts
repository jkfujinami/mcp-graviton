#!/usr/bin/env node
import path from "path";
import { runDaemon } from "./daemon";
import { DaemonClient } from "./daemon-client";

const USAGE = `Usage: graviton <command> [args...]

Daemon:
  daemon                              Start the daemon (foreground; use & to background)
  stop                                Tell the daemon to exit
  ping                                Check daemon liveness

Sessions:
  create <name> --workspace <path> --task <text>
         [--auto-shell] [--auto-file] [--auto-browser] [--model <id>]
  send <name> <message...> [--mode queue|interrupt] [--model <id>]
  get <name> [--cursor <json>] [--full]
  list
  approve <name> <stepIndex> [--scope once|conversation]
  deny <name> <stepIndex>
  reset <name>
  close <name>
  watch [<name>]                      Stream notifications (omit name for all sessions)
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function printResult(result: any) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function withClient(fn: (c: DaemonClient) => Promise<any>): Promise<any> {
  const c = await DaemonClient.connect();
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stderr.write(USAGE);
    return;
  }

  if (cmd === "daemon") {
    await runDaemon();
    // runDaemon resolves once listening; keep process alive
    return new Promise<void>(() => {});
  }

  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case "ping": {
      const r = await withClient((c) => c.request("ping"));
      printResult(r);
      return;
    }

    case "stop": {
      try {
        await withClient(async (c) => c.request("shutdown"));
        process.stdout.write("Daemon stopping.\n");
      } catch (e: any) {
        die(`stop failed: ${e.message}`);
      }
      return;
    }

    case "create": {
      const [name] = positional;
      if (!name) die("Usage: graviton create <name> --workspace <path> --task <text>");
      if (!flags.workspace || typeof flags.workspace !== "string") {
        die("--workspace <path> is required");
      }
      if (!flags.task || typeof flags.task !== "string") {
        die("--task <text> is required");
      }
      const autoApproveRules = {
        runCommand: flags["auto-shell"] === true,
        filePermission: flags["auto-file"] === true,
        openBrowserUrl: flags["auto-browser"] === true,
      };
      const r = await withClient((c) =>
        c.request("create_session", {
          name,
          workspace: path.resolve(String(flags.workspace)),
          task: String(flags.task),
          modelId: flags.model ? Number(flags.model) : undefined,
          autoApproveRules,
        })
      );
      printResult(r);
      return;
    }

    case "send": {
      const [name, ...msgParts] = positional;
      if (!name || msgParts.length === 0) {
        die("Usage: graviton send <name> <message...>");
      }
      const message = msgParts.join(" ");
      const r = await withClient((c) =>
        c.request("send_message", {
          session: name,
          message,
          mode: typeof flags.mode === "string" ? flags.mode : "queue",
          modelId: flags.model ? Number(flags.model) : undefined,
        })
      );
      printResult(r);
      return;
    }

    case "get": {
      const [name] = positional;
      if (!name) die("Usage: graviton get <name>");
      let cursor: any = undefined;
      if (typeof flags.cursor === "string") {
        try {
          cursor = JSON.parse(flags.cursor);
        } catch (e: any) {
          die(`--cursor must be valid JSON: ${e.message}`);
        }
      }
      const r = await withClient((c) =>
        c.request("get_output", { session: name, cursor })
      );
      printResult(r);
      return;
    }

    case "list": {
      const r = await withClient((c) => c.request("list_sessions"));
      printResult(r);
      return;
    }

    case "approve": {
      const [name, idxStr] = positional;
      if (!name || !idxStr) die("Usage: graviton approve <name> <stepIndex>");
      const r = await withClient((c) =>
        c.request("approve_step", {
          session: name,
          stepIndex: Number(idxStr),
          scope: typeof flags.scope === "string" ? flags.scope : "conversation",
        })
      );
      printResult(r);
      return;
    }

    case "deny": {
      const [name, idxStr] = positional;
      if (!name || !idxStr) die("Usage: graviton deny <name> <stepIndex>");
      const r = await withClient((c) =>
        c.request("deny_step", { session: name, stepIndex: Number(idxStr) })
      );
      printResult(r);
      return;
    }

    case "reset": {
      const [name] = positional;
      if (!name) die("Usage: graviton reset <name>");
      const r = await withClient((c) => c.request("reset_session", { session: name }));
      printResult(r);
      return;
    }

    case "close": {
      const [name] = positional;
      if (!name) die("Usage: graviton close <name>");
      const r = await withClient((c) => c.request("close_session", { session: name }));
      printResult(r);
      return;
    }

    case "watch": {
      const sessName = positional[0] ?? "*";
      const c = await DaemonClient.connect();
      await c.request("subscribe", { session: sessName });
      c.onNotification((notif) => {
        process.stdout.write(JSON.stringify(notif) + "\n");
      });
      process.on("SIGINT", () => {
        c.close();
        process.exit(0);
      });
      // Hold open forever
      await new Promise<void>(() => {});
      return;
    }

    default:
      die(`Unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e: any) => {
  console.error("Error:", e?.message ?? e);
  process.exit(1);
});
