import { EventEmitter } from "events";
import { Cascade } from "antigravity-client";
import type { ApprovalRequest } from "antigravity-client";
import {
  IGravitonSession,
  GravitonSessionStatus,
  GravitonStepSummary,
  GravitonOutput,
  GravitonCursor,
  PendingApprovalSummary,
  SendMessageResult,
  SessionEvent,
} from "./types";
import { IApprovalStrategy } from "./approval";

export class GravitonSession extends EventEmitter implements IGravitonSession {
  public readonly name: string;
  public readonly workspacePath: string;
  private readonly cascade: Cascade;
  private readonly approvalStrategy: IApprovalStrategy;

  private _status: GravitonSessionStatus = "idle";
  private textBuffer: string = "";
  private thinkingBuffer: string = "";
  private commandOutputBuffer: string = "";
  private steps: Map<number, GravitonStepSummary> = new Map();
  private pendingApprovals: Map<number, ApprovalRequest> = new Map();

  private messageQueue: { text: string; modelId?: number }[] = [];

  constructor(
    name: string,
    workspacePath: string,
    cascade: Cascade,
    approvalStrategy: IApprovalStrategy
  ) {
    super();
    this.name = name;
    this.workspacePath = workspacePath;
    this.cascade = cascade;
    this.approvalStrategy = approvalStrategy;

    this.setupListeners();
  }

  public get cascadeId(): string {
    return this.cascade.cascadeId;
  }

  public get status(): GravitonSessionStatus {
    if (this.pendingApprovals.size > 0) {
      return "waiting_user";
    }
    return this._status;
  }

  on(event: SessionEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: SessionEvent, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  private setupListeners() {
    this.cascade.on("statusChange", (ev: any) => {
      const current = String(ev.status).toLowerCase();
      const prev = String(ev.previousStatus).toLowerCase();

      if (current === "idle") {
        this._status = "idle";
        this.processNextMessage().catch((e) => {
          this._status = "error";
          this.emit("error", e);
        });
        if (prev !== "idle" && this.pendingApprovals.size === 0) {
          this.emit("idle");
        }
      } else if (current === "running") {
        this._status = "running";
      } else if (current === "busy") {
        this._status = "busy";
      } else if (current === "canceling") {
        this._status = "canceling";
      }
    });

    this.cascade.on("stepNew", (ev: any) => {
      const step = ev.step;
      this.steps.set(step.index, {
        index: step.index,
        type: step.type || "",
        category: step.category || "",
        status: step.status || "",
        description: step.description || "",
      });
    });

    this.cascade.on("stepUpdate", (ev: any) => {
      const step = ev.step;
      const prevSummary = this.steps.get(step.index);
      if (prevSummary) {
        prevSummary.status = step.status || "";
        prevSummary.description = step.description || "";
      }
    });

    this.cascade.on("text", (ev: any) => {
      this.textBuffer += ev.delta;
    });

    this.cascade.on("thinking", (ev: any) => {
      this.thinkingBuffer += ev.delta;
    });

    this.cascade.on("commandOutput", (ev: any) => {
      this.commandOutputBuffer += ev.delta;
    });

    this.cascade.on("interaction", async (req: ApprovalRequest) => {
      const r = req as any;

      if (this.approvalStrategy.shouldAutoApprove(r.type, r.description)) {
        try {
          if (r.type === "file_permission") {
            await r.approve("conversation");
          } else {
            await r.approve();
          }
          return;
        } catch (e) {
          // fall through to manual approval
        }
      }

      if (!r.needsApproval) return;

      this.pendingApprovals.set(r.stepIndex, req);
      this.emit("approvalRequest", req);
    });

    this.cascade.on("error", (err: any) => {
      this._status = "error";
      this.emit("error", err);
    });
  }

  public async sendMessage(
    text: string,
    options?: { mode?: "queue" | "interrupt"; modelId?: number }
  ): Promise<SendMessageResult> {
    const mode = options?.mode ?? "queue";
    const modelId = options?.modelId;

    if (mode === "interrupt") {
      const dropped = this.messageQueue.length;
      this.messageQueue = [];
      this.pendingApprovals.clear();
      this._status = "canceling";

      try {
        await this.cascade.cancel();
        await this.awaitStatus("idle", 5000);
      } catch (e) {
        // ignore cancel timeout / transport drops; we proceed to send anyway
      }

      this._status = "running";
      await this.cascade.sendMessage(text, { model: modelId } as any);
      return { accepted: true, droppedMessages: dropped };
    }

    this.messageQueue.push({ text, modelId });
    if (this.status === "idle") {
      await this.processNextMessage();
    }
    return { accepted: true, droppedMessages: 0 };
  }

  private async processNextMessage(): Promise<void> {
    if (this.messageQueue.length === 0) return;
    const msg = this.messageQueue.shift()!;
    this._status = "running";
    try {
      await this.cascade.sendMessage(msg.text, { model: msg.modelId } as any);
    } catch (e) {
      this._status = "error";
      this.emit("error", e);
    }
  }

  private awaitStatus(target: GravitonSessionStatus, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.status === target) return resolve();
      const handler = (_ev: any) => {
        if (this.status === target) {
          clearTimeout(timer);
          this.cascade.off("statusChange", handler);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.cascade.off("statusChange", handler);
        reject(new Error(`Timeout waiting for status ${target}`));
      }, timeoutMs);
      this.cascade.on("statusChange", handler);
    });
  }

  public getOutput(cursor?: GravitonCursor): GravitonOutput {
    const stepsArray = Array.from(this.steps.values()).sort((a, b) => a.index - b.index);
    const currentCursor: GravitonCursor = {
      textOffset: this.textBuffer.length,
      thinkingOffset: this.thinkingBuffer.length,
      commandOffset: this.commandOutputBuffer.length,
      stepOffset: stepsArray.length,
    };

    const pendingList: PendingApprovalSummary[] = Array.from(
      this.pendingApprovals.entries()
    ).map(([index, req]) => {
      const r = req as any;
      return {
        stepIndex: index,
        type: r.type || "",
        description: r.description || "",
        commandLine: r.commandLine,
        filePath: r.filePath,
        url: r.url,
      };
    });

    if (cursor) {
      return {
        sessionName: this.name,
        status: this.status,
        text: this.textBuffer.slice(cursor.textOffset),
        thinking: this.thinkingBuffer.slice(cursor.thinkingOffset),
        commandOutput: this.commandOutputBuffer.slice(cursor.commandOffset),
        steps: stepsArray.slice(cursor.stepOffset),
        pendingApprovals: pendingList,
        cursor: currentCursor,
        isDelta: true,
      };
    }

    return {
      sessionName: this.name,
      status: this.status,
      text: this.textBuffer,
      thinking: this.thinkingBuffer,
      commandOutput: this.commandOutputBuffer,
      steps: stepsArray,
      pendingApprovals: pendingList,
      cursor: currentCursor,
      isDelta: false,
    };
  }

  public async approveStep(
    stepIndex: number,
    scope?: "once" | "conversation"
  ): Promise<void> {
    const req = this.pendingApprovals.get(stepIndex);
    if (!req) {
      throw new Error(`No pending approval request found for step index ${stepIndex}`);
    }

    this.pendingApprovals.delete(stepIndex);
    this._status = "running";

    const r = req as any;
    if (r.type === "file_permission" && scope) {
      await r.approve(scope);
    } else {
      await r.approve();
    }
  }

  public async denyStep(stepIndex: number): Promise<void> {
    const req = this.pendingApprovals.get(stepIndex);
    if (!req) {
      throw new Error(`No pending approval request found for step index ${stepIndex}`);
    }
    this.pendingApprovals.delete(stepIndex);
    const r = req as any;
    if (typeof r.deny === "function") {
      await r.deny();
    }
  }

  /**
   * Clears an `error` state back to `idle`. No-op for other states.
   */
  public reset(): void {
    if (this._status === "error") {
      this._status = "idle";
    }
  }

  public close() {
    this._status = "closed";
    this.cascade.removeAllListeners();
    this.pendingApprovals.clear();
    this.emit("closed");
    this.removeAllListeners();
  }
}
