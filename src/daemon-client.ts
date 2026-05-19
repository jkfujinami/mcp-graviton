import net from "net";
import { SOCKET_PATH } from "./daemon";

export interface Notification {
  method: string;
  params: any;
}

export class DaemonClient {
  private sock: net.Socket;
  private buf = "";
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  private notifHandlers: ((notif: Notification) => void)[] = [];
  private nextId = 1;
  private closed = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk) => this.onData(chunk.toString()));
    sock.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("Connection closed"));
      this.pending.clear();
    });
    sock.on("error", () => {
      /* surfaced via individual request promises */
    });
  }

  private onData(text: string) {
    this.buf += text;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(String(msg.id))) {
        const p = this.pending.get(String(msg.id))!;
        this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.notifHandlers) {
          try {
            h(msg as Notification);
          } catch {}
        }
      }
    }
  }

  static connect(socketPath: string = SOCKET_PATH): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      const onConnect = () => {
        sock.off("error", onError);
        resolve(new DaemonClient(sock));
      };
      const onError = (e: NodeJS.ErrnoException) => {
        sock.off("connect", onConnect);
        if (e.code === "ENOENT") {
          reject(
            new Error(
              `Daemon not running (no socket at ${socketPath}). Start it with: graviton daemon`
            )
          );
        } else if (e.code === "ECONNREFUSED") {
          reject(
            new Error(
              `Daemon socket is stale at ${socketPath}. Remove it and restart.`
            )
          );
        } else {
          reject(e);
        }
      };
      sock.once("connect", onConnect);
      sock.once("error", onError);
    });
  }

  request(method: string, params: any = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Client is closed"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sock.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onNotification(handler: (notif: Notification) => void) {
    this.notifHandlers.push(handler);
  }

  close() {
    this.closed = true;
    this.sock.end();
  }
}
