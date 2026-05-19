import { AntigravityClient } from "antigravity-client";
import { IGravitonSession, SessionMetadata, AutoApproveRules } from "./types";
import { GravitonSession } from "./session";
import { ISessionPersistence } from "./persistence";
import { IApprovalStrategy, ConfigurableApprovalStrategy } from "./approval";
import path from "path";

export interface IGravitonEngine {
  createSession(
    name: string,
    workspacePath: string,
    initialTask: string,
    options?: { modelId?: number; autoApproveRules?: AutoApproveRules }
  ): Promise<IGravitonSession>;
  getSession(name: string): IGravitonSession | undefined;
  destroySession(name: string): Promise<void>;
  listSessions(): IGravitonSession[];
  resumeAllSavedSessions(): Promise<void>;
  shutdown(): Promise<void>;
}

export class GravitonEngine implements IGravitonEngine {
  private clients = new Map<string, AntigravityClient>();
  private sessions = new Map<string, IGravitonSession>();
  private readonly persistence: ISessionPersistence;
  private readonly defaultApprovalStrategy: IApprovalStrategy;

  constructor(
    persistence: ISessionPersistence,
    defaultApprovalStrategy?: IApprovalStrategy
  ) {
    this.persistence = persistence;
    this.defaultApprovalStrategy = defaultApprovalStrategy || new ConfigurableApprovalStrategy();
  }

  public async getOrLaunchClient(workspacePath: string): Promise<AntigravityClient> {
    // Caller is expected to pass an already-resolved absolute path.
    let client = this.clients.get(workspacePath);
    if (!client) {
      client = await AntigravityClient.launch({ workspacePath });
      this.clients.set(workspacePath, client);
    }
    return client;
  }

  public async createSession(
    name: string,
    workspacePath: string,
    initialTask: string,
    options?: { modelId?: number; autoApproveRules?: AutoApproveRules }
  ): Promise<IGravitonSession> {
    if (this.sessions.has(name)) {
      throw new Error(`Session with name "${name}" already exists.`);
    }

    const resolvedPath = path.resolve(workspacePath);
    const client = await this.getOrLaunchClient(resolvedPath);
    const cascade = await client.startCascade();

    const strategy = options?.autoApproveRules
      ? new ConfigurableApprovalStrategy(options.autoApproveRules)
      : this.defaultApprovalStrategy;

    const session = new GravitonSession(name, resolvedPath, cascade, strategy);
    this.sessions.set(name, session);

    const metadata: SessionMetadata = {
      name,
      cascadeId: cascade.cascadeId,
      workspacePath: resolvedPath,
      modelId: options?.modelId,
      createdAt: new Date().toISOString(),
      autoApproveRules: options?.autoApproveRules,
    };
    await this.persistence.save(metadata);

    await session.sendMessage(initialTask, { mode: "queue", modelId: options?.modelId });

    return session;
  }

  public getSession(name: string): IGravitonSession | undefined {
    return this.sessions.get(name);
  }

  public listSessions(): IGravitonSession[] {
    return Array.from(this.sessions.values());
  }

  public async destroySession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;

    session.close();
    this.sessions.delete(name);

    // Evict persistent files on explicit destruction
    await this.persistence.delete(name);

    const ws = session.workspacePath;
    const activeInWs = Array.from(this.sessions.values()).some((s) => s.workspacePath === ws);

    if (!activeInWs) {
      const client = this.clients.get(ws);
      if (client) {
        client.dispose();
        await (client as any).launcher?.stop();
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Resume all persisted sessions.
   */
  public async resumeAllSavedSessions(): Promise<void> {
    const savedList = await this.persistence.list();
    for (const metadata of savedList) {
      try {
        const resolvedPath = path.resolve(metadata.workspacePath);
        const client = await this.getOrLaunchClient(resolvedPath);
        const cascade = await client.resumeCascade(metadata.cascadeId);

        const strategy = metadata.autoApproveRules
          ? new ConfigurableApprovalStrategy(metadata.autoApproveRules)
          : this.defaultApprovalStrategy;

        const session = new GravitonSession(metadata.name, resolvedPath, cascade, strategy);
        this.sessions.set(metadata.name, session);
      } catch (e) {
        // Avoid cascading startup crashes if single workspace environment drops
      }
    }
  }

  public async shutdown(): Promise<void> {
    for (const name of this.sessions.keys()) {
      await this.destroySession(name);
    }
  }
}
