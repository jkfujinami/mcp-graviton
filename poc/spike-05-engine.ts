/**
 * Spike 5: mcp-graviton エンジン PoC
 * 
 * 設計書 (docs/) のセッション・ライフサイクル、協調動作、承認フローに準拠した
 * GravitonSession / GravitonEngine のコア実装と動作実証。
 * 
 * 実行: npx tsx poc/spike-05-engine.ts
 */

import { AntigravityClient, Cascade } from "antigravity-client";
import type { ApprovalRequest } from "antigravity-client";
import fs from "fs";
import os from "os";
import path from "path";

const log = (label: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${label.padEnd(12)} ${msg}\n`);
};

// docs/lifecycle.md に定義されたセッション状態
export type GravitonSessionStatus =
  | "idle"
  | "running"
  | "busy"
  | "canceling"
  | "waiting_user"
  | "error"
  | "closed";

export interface GravitonStepSummary {
  index: number;
  type: string;
  category: string;
  status: string;
  description: string;
}

export interface GravitonOutput {
  sessionName: string;
  status: GravitonSessionStatus;
  text: string;
  thinking: string;
  commandOutput: string;
  steps: GravitonStepSummary[];
  pendingApprovals: {
    stepIndex: number;
    type: string;
    description: string;
  }[];
}

/**
 * 単一の Antigravity Cascade をラップし、状態、キュー、バッファを管理するクラス。
 */
export class GravitonSession {
  public readonly name: string;
  public readonly workspacePath: string;
  private readonly cascade: Cascade;

  // 内部状態
  private _status: GravitonSessionStatus = "idle";
  private textBuffer: string = "";
  private thinkingBuffer: string = "";
  private commandOutputBuffer: string = "";
  private steps: Map<number, GravitonStepSummary> = new Map();
  private pendingApprovals: Map<number, ApprovalRequest> = new Map();

  // 非同期メッセージキュー (docs/lifecycle.md § send_message の queue 実装に準拠)
  private messageQueue: { text: string; modelId?: number }[] = [];

  constructor(name: string, workspacePath: string, cascade: Cascade) {
    this.name = name;
    this.workspacePath = workspacePath;
    this.cascade = cascade;

    this.setupListeners();
  }

  public get cascadeId(): string {
    return this.cascade.cascadeId;
  }

  public get status(): GravitonSessionStatus {
    // trajectoryの末尾状態を見て、承認待ちがあれば waiting_user に倒す
    if (this.pendingApprovals.size > 0) {
      return "waiting_user";
    }
    return this._status;
  }

  /**
   * Cascade のイベント購読設定 (docs/implementation-notes.md § 4 に準拠)
   */
  private setupListeners() {
    this.cascade.on("statusChange", (ev: any) => {
      const prev = ev.previousStatus as string;
      const current = ev.status as string;

      log(`session:${this.name}`, `statusChange: ${prev} → ${current}`);

      // 状態機械マッピング
      if (current.toLowerCase() === "idle") {
        this._status = "idle";
        // キューにメッセージがあれば順次送信
        this.processNextMessage();
      } else if (current.toLowerCase() === "running") {
        this._status = "running";
      } else if (current.toLowerCase() === "busy") {
        this._status = "busy";
      } else if (current.toLowerCase() === "canceling") {
        this._status = "canceling";
      }
    });

    // 新ステップ開始時
    this.cascade.on("stepNew", (ev: any) => {
      const step = ev.step;
      this.steps.set(step.index, {
        index: step.index,
        type: step.type || "",
        category: step.category || "",
        status: step.status || "",
        description: step.description || "",
      });
      log(`session:${this.name}`, `StepNew: #${step.index} ${step.type} [${step.status}]`);
    });

    // ステップ更新時
    this.cascade.on("stepUpdate", (ev: any) => {
      const step = ev.step;
      const prevSummary = this.steps.get(step.index);
      if (prevSummary) {
        prevSummary.status = step.status || "";
        prevSummary.description = step.description || "";
      }
      log(`session:${this.name}`, `StepUpdate: #${step.index} status → ${step.status}`);
    });

    // 出力テキストのストリーミング
    this.cascade.on("text", (ev: any) => {
      this.textBuffer += ev.delta;
    });

    // 思考トークンのストリーミング
    this.cascade.on("thinking", (ev: any) => {
      this.thinkingBuffer += ev.delta;
    });

    // コマンド出力のストリーミング
    this.cascade.on("commandOutput", (ev: any) => {
      this.commandOutputBuffer += ev.delta;
    });

    // 承認リクエストの捕捉 (docs/implementation-notes.md § 5 に準拠)
    this.cascade.on("interaction", (req: ApprovalRequest) => {
      const r = req as any;
      if (!r.needsApproval) {
        log(`session:${this.name}`, `Notification (auto-run): ${r.description}`);
        return;
      }

      // trajectory から現在の step インデックスを見つける
      const stepIndex = this.findWaitingStepIndex(r.description);
      log(`session:${this.name}`, `Interaction Required: step[${stepIndex}] type=${r.type} description=${r.description}`);

      this.pendingApprovals.set(stepIndex, req);
    });

    // エラーハンドリング
    this.cascade.on("error", (err: any) => {
      log(`session:${this.name}`, `Error: ${String(err)}`);
      this._status = "error";
    });
  }

  /**
   * 承認要求の説明から対応する stepIndex を逆算
   */
  private findWaitingStepIndex(description: string): number {
    const steps = this.cascade.state.trajectory?.steps || [];
    // 逆順で "running" や "waiting" である step で、説明が一致するか近いものを探す
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.status === "running" || s.status === "waiting") {
        return s.step?.index ?? i;
      }
    }
    return steps.length > 0 ? steps[steps.length - 1].step?.index ?? 0 : 0;
  }

  /**
   * メッセージ送信の queue / interrupt 実装 (docs/lifecycle.md § send_message に準拠)
   */
  public async sendMessage(
    text: string,
    options?: { mode?: "queue" | "interrupt"; modelId?: number }
  ): Promise<void> {
    const mode = options?.mode ?? "queue";
    const modelId = options?.modelId;

    if (mode === "interrupt") {
      log(`session:${this.name}`, `Interrupt mode. Canceling active run.`);
      // 内部キューを破棄
      this.messageQueue = [];
      // 承認待ちもクリア
      this.pendingApprovals.clear();
      this._status = "canceling";

      try {
        await this.cascade.cancel();
        // idle に戻るまで少し待機 (statusChangeイベントで処理されるが、念のため待つ)
        await this.awaitStatus("idle", 5000);
      } catch (e) {
        log(`session:${this.name}`, `Cancel failed: ${e}`);
      }

      // 即時送信
      log(`session:${this.name}`, `Sending interrupt message`);
      await this.cascade.sendMessage(text, { model: modelId } as any);
    } else {
      // queue モード
      this.messageQueue.push({ text, modelId });
      if (this.status === "idle") {
        await this.processNextMessage();
      } else {
        log(`session:${this.name}`, `Session is busy (${this.status}). Message queued. Queue size: ${this.messageQueue.length}`);
      }
    }
  }

  /**
   * キューからメッセージを取り出して送信
   */
  private async processNextMessage() {
    if (this.messageQueue.length === 0) return;
    const msg = this.messageQueue.shift()!;
    log(`session:${this.name}`, `Processing queued message`);
    this._status = "running";
    try {
      await this.cascade.sendMessage(msg.text, { model: msg.modelId } as any);
    } catch (e) {
      log(`session:${this.name}`, `Failed to send message: ${e}`);
      this._status = "error";
    }
  }

  /**
   * 特定の状態になるまで待機するヘルパー
   */
  private awaitStatus(target: GravitonSessionStatus, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.status === target) return resolve();
      const timer = setTimeout(() => {
        this.cascade.off("statusChange", handler as any);
        reject(new Error(`Timeout waiting for status ${target}`));
      }, timeoutMs);

      const handler = () => {
        if (this.status === target) {
          clearTimeout(timer);
          this.cascade.off("statusChange", handler as any);
          resolve();
        }
      };
      this.cascade.on("statusChange", handler as any);
    });
  }

  /**
   * 呼んだ瞬間のセッション出力スナップショットを返す (docs/mcp-tools.md § 3 に準拠)
   */
  public getOutput(): GravitonOutput {
    const pendingList = Array.from(this.pendingApprovals.entries()).map(([index, req]) => {
      const r = req as any;
      return {
        stepIndex: index,
        type: r.type || "",
        description: r.description || "",
      };
    });

    return {
      sessionName: this.name,
      status: this.status,
      text: this.textBuffer,
      thinking: this.thinkingBuffer,
      commandOutput: this.commandOutputBuffer,
      steps: Array.from(this.steps.values()),
      pendingApprovals: pendingList,
    };
  }

  /**
   * 指定したステップを承認する (docs/implementation-notes.md § 5 に準拠)
   */
  public async approveStep(
    stepIndex: number,
    scope?: "once" | "conversation"
  ): Promise<void> {
    const req = this.pendingApprovals.get(stepIndex);
    if (!req) {
      throw new Error(`No pending approval request found for step index ${stepIndex}`);
    }

    log(`session:${this.name}`, `Approving step[${stepIndex}] scope=${scope ?? "default"}`);
    this.pendingApprovals.delete(stepIndex);

    // 状態をrunningに戻す (statusChangeでも変更されるが、即時追従のため)
    this._status = "running";
    
    const r = req as any;
    if (r.type === "file_permission" && scope) {
      await r.approve(scope);
    } else {
      await r.approve();
    }
  }

  /**
   * セッションの廃棄処理
   */
  public close() {
    this._status = "closed";
    this.cascade.removeAllListeners();
    this.pendingApprovals.clear();
    log(`session:${this.name}`, `Session closed`);
  }
}

/**
 * 複数ワークスペースのクライアント管理（LS プロセスプール）と
 * セッションレジストリを統括するエンジンクラス。
 */
export class GravitonEngine {
  private clients = new Map<string, AntigravityClient>();
  private sessions = new Map<string, GravitonSession>();

  constructor() {}

  /**
   * ワークスペースに対応した AntigravityClient をプールから取得、無ければ起動
   */
  public async getOrLaunchClient(workspacePath: string): Promise<AntigravityClient> {
    const resolvedPath = path.resolve(workspacePath);
    let client = this.clients.get(resolvedPath);
    if (!client) {
      log("engine", `Launching new Antigravity LS process for workspace: ${resolvedPath}`);
      client = await AntigravityClient.launch({ workspacePath: resolvedPath });
      this.clients.set(resolvedPath, client);
    }
    return client;
  }

  /**
   * セッションの作成
   */
  public async createSession(
    name: string,
    workspacePath: string,
    initialTask: string,
    options?: { modelId?: number }
  ): Promise<GravitonSession> {
    if (this.sessions.has(name)) {
      throw new Error(`Session with name "${name}" already exists.`);
    }

    const client = await this.getOrLaunchClient(workspacePath);
    log("engine", `Starting cascade for session: ${name}`);
    const cascade = await client.startCascade();

    const session = new GravitonSession(name, workspacePath, cascade);
    this.sessions.set(name, session);

    // 初期タスクを送信
    log("engine", `Sending initial task to session "${name}"`);
    await session.sendMessage(initialTask, { mode: "queue", modelId: options?.modelId });

    return session;
  }

  /**
   * 既存セッションの取得
   */
  public getSession(name: string): GravitonSession | undefined {
    return this.sessions.get(name);
  }

  /**
   * セッションの完全停止
   */
  public async destroySession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;

    session.close();
    this.sessions.delete(name);

    // このワークスペースで他にセッションが走っているかチェック
    const ws = session.workspacePath;
    const activeInWs = Array.from(this.sessions.values()).some((s) => s.workspacePath === ws);

    // 走っていなければ対応するLSプロセスをクリーンに停止
    if (!activeInWs) {
      const client = this.clients.get(ws);
      if (client) {
        log("engine", `No active sessions in workspace. Stopping LS process: ${ws}`);
        client.dispose();
        await (client as any).launcher?.stop();
        this.clients.delete(ws);
      }
    }
  }

  /**
   * すべてのエンジンリソースをクリーンアップ
   */
  public async shutdown(): Promise<void> {
    log("engine", `Shutting down Graviton Engine...`);
    for (const name of this.sessions.keys()) {
      await this.destroySession(name);
    }
  }
}

// ── 以下、PoCの動作確認用テストメイン ──
async function runPoCTest() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "graviton-engine-poc-"));
  log("test", `Temporary workspace generated: ${workspace}`);

  const killTimer = setTimeout(() => {
    log("test", "Force exit after 150 seconds");
    process.exit(2);
  }, 150_000);

  const engine = new GravitonEngine();

  try {
    const sessionName = "doc-aligned-poc";
    const initialTask = [
      `現在の作業ディレクトリは ${workspace} です。`,
      `1. シェルで \`ls -la\` を実行してください。`,
      `2. POCOUT.md というファイルを生成し、「Engine test output」と記載してください。`,
      `終わったら "DONE" と回答してください。`,
    ].join("\n");

    // セッション起動 (Gemini 3 Flash をモデル ID 1133 で指定)
    log("test", `Creating session "${sessionName}"...`);
    const session = await engine.createSession(sessionName, workspace, initialTask, {
      modelId: 1133,
    });

    log("test", `Session established. CascadeId: ${session.cascadeId}`);

    // ポーリング監視ループ (3秒おきに出力と状態を確認、承認要求があれば承認)
    const monitorInterval = setInterval(async () => {
      const output = session.getOutput();
      log("monitor", `Session status: ${output.status}`);

      if (output.pendingApprovals.length > 0) {
        for (const req of output.pendingApprovals) {
          log("monitor", `Detected pending approval for step[${req.stepIndex}]: ${req.description}`);
          try {
            await session.approveStep(req.stepIndex, "conversation");
          } catch (e) {
            log("monitor", `Approval failed: ${e}`);
          }
        }
      }

      if (output.status === "idle") {
        clearInterval(monitorInterval);
        log("test", `--- FINAL ASSISTANT TEXT ---`);
        console.log(output.text);
        log("test", `----------------------------`);

        // ファイル生成検証
        const checkFile = path.join(workspace, "POCOUT.md");
        if (fs.existsSync(checkFile)) {
          log("test", `Verification SUCCESS: POCOUT.md exists with contents: ${fs.readFileSync(checkFile, "utf-8").trim()}`);
        } else {
          log("test", `Verification FAILED: POCOUT.md not found.`);
        }

        // シャットダウン
        await engine.shutdown();
        clearTimeout(killTimer);
        log("test", `Engine shutdown completed. Exiting.`);
        process.exit(0);
      }
    }, 3000);

  } catch (e) {
    console.error("Test execution failed:", e);
    await engine.shutdown();
    process.exit(1);
  }
}

// PoC単体実行時のみテストをキック
if (require.main === module) {
  runPoCTest();
}
