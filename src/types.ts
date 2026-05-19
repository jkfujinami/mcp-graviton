import type { ApprovalRequest } from "antigravity-client";

export type GravitonSessionStatus =
  | "idle"
  | "running"
  | "busy"
  | "canceling"
  | "waiting_user"
  | "error"
  | "closed";

export type SessionEvent =
  | "idle"
  | "error"
  | "approvalRequest"
  | "closed";

export interface GravitonStepSummary {
  index: number;
  type: string;
  category: string;
  status: string;
  description: string;
}

export interface SessionMetadata {
  name: string;
  cascadeId: string;
  workspacePath: string;
  modelId?: number;
  createdAt: string;
  autoApproveRules?: AutoApproveRules;
}

export interface AutoApproveRules {
  runCommand?: boolean | "once" | "always";
  filePermission?: boolean | "once" | "always";
  openBrowserUrl?: boolean | "once" | "always";
}

export interface GravitonCursor {
  textOffset: number;
  thinkingOffset: number;
  commandOffset: number;
  stepOffset: number;
}

export interface PendingApprovalSummary {
  stepIndex: number;
  type: string;
  description: string;
  commandLine?: string;
  filePath?: string;
  url?: string;
}

export interface GravitonOutput {
  sessionName: string;
  status: GravitonSessionStatus;
  /**
   * Accumulated assistant text. If `cursor` was passed to `getOutput()`,
   * this is the delta since that cursor; otherwise the full buffer.
   */
  text: string;
  thinking: string;
  commandOutput: string;
  steps: GravitonStepSummary[];
  pendingApprovals: PendingApprovalSummary[];
  cursor: GravitonCursor;
  /** True if the buffers above are deltas (i.e. a cursor was passed). */
  isDelta: boolean;
}

export interface SendMessageResult {
  accepted: boolean;
  /** Number of queued messages dropped (only nonzero for `mode: "interrupt"`). */
  droppedMessages: number;
}

export interface IGravitonSession {
  readonly name: string;
  readonly workspacePath: string;
  readonly cascadeId: string;
  readonly status: GravitonSessionStatus;
  sendMessage(
    text: string,
    options?: { mode?: "queue" | "interrupt"; modelId?: number }
  ): Promise<SendMessageResult>;
  getOutput(cursor?: GravitonCursor): GravitonOutput;
  approveStep(stepIndex: number, scope?: "once" | "conversation"): Promise<void>;
  denyStep(stepIndex: number): Promise<void>;
  reset(): void;
  close(): void;
  on(event: SessionEvent, listener: (...args: any[]) => void): this;
  off(event: SessionEvent, listener: (...args: any[]) => void): this;
}
