import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { GravitonEngine } from "./engine";
import { FileSessionPersistence } from "./persistence";
import { ConfigurableApprovalStrategy } from "./approval";
import { IGravitonSession, AutoApproveRules } from "./types";

export const DAEMON_DIR = path.join(os.homedir(), ".mcp-graviton");
export const SOCKET_PATH = path.join(DAEMON_DIR, "daemon.sock");
export const PID_PATH = path.join(DAEMON_DIR, "daemon.pid");

interface RpcRequest {
  id?: string | number;
  method: string;
  params?: any;
}

interface RpcNotification {
  method: string;
  params: any;
}

export interface RunDaemonOptions {
  socketPath?: string;
  pidPath?: string;
  storageDir?: string;
}

export async function runDaemon(opts: RunDaemonOptions = {}) {
  const socketPath = opts.socketPath ?? SOCKET_PATH;
  const pidPath = opts.pidPath ?? PID_PATH;
  const storageDir = opts.storageDir ?? path.join(DAEMON_DIR, "sessions");

  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });

  // Detect stale socket
  if (fs.existsSync(socketPath)) {
    const stale = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        probe.end();
        resolve(false);
      });
      probe.once("error", () => resolve(true));
    });
    if (!stale) {
      console.error(`[graviton daemon] another daemon already listening at ${socketPath}`);
      process.exit(1);
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  }

  fs.writeFileSync(pidPath, String(process.pid));

  const persistence = new FileSessionPersistence(storageDir);
  const strategy = new ConfigurableApprovalStrategy({
    runCommand: false,
    filePermission: false,
    openBrowserUrl: false,
  });
  const engine = new GravitonEngine(persistence, strategy);

  try {
    await engine.resumeAllSavedSessions();
  } catch (e) {
    console.error("[graviton daemon] resume failed:", e);
  }

  const subscriptions = new Map<net.Socket, Set<string>>();

  function broadcast(notif: RpcNotification) {
    const sessName = notif.params?.session;
    const line = JSON.stringify(notif) + "\n";
    for (const [sock, subs] of subscriptions) {
      if (subs.has("*") || (sessName && subs.has(sessName))) {
        try {
          sock.write(line);
        } catch {}
      }
    }
  }

  function wireSession(session: IGravitonSession) {
    session.on("idle", () =>
      broadcast({
        method: "session.idle",
        params: { session: session.name, status: session.status },
      })
    );
    session.on("approvalRequest", (req: any) =>
      broadcast({
        method: "session.approvalRequest",
        params: {
          session: session.name,
          stepIndex: req.stepIndex,
          type: req.type,
          description: req.description,
          commandLine: req.commandLine,
          filePath: req.filePath,
          url: req.url,
        },
      })
    );
    session.on("error", (err: any) =>
      broadcast({
        method: "session.error",
        params: { session: session.name, error: err?.message ?? String(err) },
      })
    );
    session.on("closed", () =>
      broadcast({
        method: "session.closed",
        params: { session: session.name },
      })
    );
  }

  engine.listSessions().forEach(wireSession);

  async function handleRequest(req: RpcRequest, sock: net.Socket): Promise<any> {
    const { method, params = {} } = req;
    switch (method) {
      case "ping":
        return { pong: true, pid: process.pid };

      case "create_session": {
        const session = await engine.createSession(
          params.name,
          params.workspace,
          params.task,
          {
            modelId: params.modelId,
            autoApproveRules: params.autoApproveRules as AutoApproveRules | undefined,
          }
        );
        wireSession(session);
        return {
          name: session.name,
          cascadeId: session.cascadeId,
          workspacePath: session.workspacePath,
          status: session.status,
        };
      }

      case "send_message": {
        const session = engine.getSession(params.session);
        if (!session) throw new Error(`Session not found: ${params.session}`);
        const result = await session.sendMessage(params.message, {
          mode: params.mode,
          modelId: params.modelId,
        });
        return { ...result, status: session.status };
      }

      case "get_output": {
        const session = engine.getSession(params.session);
        if (!session) throw new Error(`Session not found: ${params.session}`);
        return session.getOutput(params.cursor);
      }

      case "list_sessions": {
        return {
          sessions: engine.listSessions().map((s) => ({
            name: s.name,
            workspacePath: s.workspacePath,
            cascadeId: s.cascadeId,
            status: s.status,
          })),
        };
      }

      case "approve_step": {
        const session = engine.getSession(params.session);
        if (!session) throw new Error(`Session not found: ${params.session}`);
        await session.approveStep(params.stepIndex, params.scope);
        return { approved: true, status: session.status };
      }

      case "deny_step": {
        const session = engine.getSession(params.session);
        if (!session) throw new Error(`Session not found: ${params.session}`);
        await session.denyStep(params.stepIndex);
        return { denied: true, status: session.status };
      }

      case "reset_session": {
        const session = engine.getSession(params.session);
        if (!session) throw new Error(`Session not found: ${params.session}`);
        session.reset();
        return { reset: true, status: session.status };
      }

      case "close_session": {
        await engine.destroySession(params.session);
        return { closed: true };
      }

      case "subscribe": {
        const sessName = params.session ?? "*";
        if (!subscriptions.has(sock)) subscriptions.set(sock, new Set());
        subscriptions.get(sock)!.add(sessName);
        return { subscribed: sessName };
      }

      case "shutdown": {
        setImmediate(() => {
          shutdown().catch((e) => console.error("[graviton daemon] shutdown err:", e));
        });
        return { stopping: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req: RpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          sock.write(JSON.stringify({ error: "invalid JSON" }) + "\n");
          continue;
        }
        handleRequest(req, sock).then(
          (result) => {
            if (req.id !== undefined) {
              sock.write(JSON.stringify({ id: req.id, result }) + "\n");
            }
          },
          (err) => {
            if (req.id !== undefined) {
              sock.write(
                JSON.stringify({ id: req.id, error: err?.message ?? String(err) }) + "\n"
              );
            }
          }
        );
      }
    });
    sock.on("close", () => subscriptions.delete(sock));
    sock.on("error", () => subscriptions.delete(sock));
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[graviton daemon] shutting down...");
    try {
      server.close();
    } catch {}
    try {
      await engine.shutdown();
    } catch (e) {
      console.error("[graviton daemon] engine shutdown error:", e);
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    try {
      fs.unlinkSync(pidPath);
    } catch {}
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => {
      console.error(
        `[graviton daemon] listening on ${socketPath} (pid ${process.pid})`
      );
      resolve();
    });
  });
}
