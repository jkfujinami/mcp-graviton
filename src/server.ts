import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { IGravitonEngine } from "./engine";
import { AutoApproveRules } from "./types";

export class McpServerAdapter {
  private readonly server: Server;
  private readonly engine: IGravitonEngine;

  constructor(engine: IGravitonEngine) {
    this.engine = engine;
    this.server = new Server(
      {
        name: "mcp-graviton",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // ツール一覧の公開
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "create_session",
            description: "Spawn a new Google Antigravity worker session under a specific workspace.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Unique identifier name for this session." },
                task: { type: "string", description: "Initial instruction task prompt." },
                workspace: { type: "string", description: "Absolute path to the target working workspace directory." },
                modelId: { type: "number", description: "Optional model ID (e.g. 1133 for Gemini 3 Flash)." },
                autoApproveRules: {
                  type: "object",
                  description: "Optional auto-approval policy flags for commands, file writes, and browser URLs.",
                  properties: {
                    runCommand: { type: "boolean", description: "Automatically execute terminal scripts." },
                    filePermission: { type: "boolean", description: "Automatically write/edit local files." },
                    openBrowserUrl: { type: "boolean", description: "Automatically visit web pages." }
                  }
                }
              },
              required: ["name", "task", "workspace"],
            },
          },
          {
            name: "send_message",
            description: "Send a prompt or command task into an active session context.",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string", description: "Name of the target session." },
                message: { type: "string", description: "Prompt input text." },
                mode: {
                  type: "string",
                  enum: ["queue", "interrupt"],
                  description: "Execution strategy. queue stacks prompt up; interrupt cancels ongoing runs immediately.",
                  default: "queue"
                },
                modelId: { type: "number", description: "Optional model ID to override." }
              },
              required: ["session", "message"],
            },
          },
          {
            name: "get_output",
            description: "Retrieve a snapshot of outputs, steps, and pending interaction requests.",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string", description: "Name of the target session." },
                cursor: {
                  type: "object",
                  description: "Optional cursor to perform efficient delta polling.",
                  properties: {
                    textOffset: { type: "number" },
                    thinkingOffset: { type: "number" },
                    commandOffset: { type: "number" },
                    stepOffset: { type: "number" }
                  }
                }
              },
              required: ["session"],
            },
          },
          {
            name: "list_sessions",
            description: "List currently tracked session nodes.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "approve_step",
            description: "Authorize a step that is paused waiting for user input.",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string", description: "Target session name." },
                stepIndex: { type: "number", description: "Index of the paused step." },
                scope: {
                  type: "string",
                  enum: ["once", "conversation"],
                  description: "Scope of approval permissions for security clearance.",
                  default: "conversation"
                }
              },
              required: ["session", "stepIndex"],
            },
          },
          {
            name: "deny_step",
            description: "Reject a step that is paused waiting for user input.",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string", description: "Target session name." },
                stepIndex: { type: "number", description: "Index of the paused step." }
              },
              required: ["session", "stepIndex"],
            },
          },
          {
            name: "reset_session",
            description: "Clear a session's error state back to idle so it can accept new messages.",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string", description: "Target session name." }
              },
              required: ["session"],
            },
          },
          {
            name: "close_session",
            description: "Gracefully shut down a session, clearing workspace memory allocations.",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string", description: "Name of the session to terminate." }
              },
              required: ["session"],
            },
          }
        ],
      };
    });

    // ツール実行のハンドリング
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "create_session": {
            const { name: sName, task, workspace, modelId, autoApproveRules } = args as any;
            const session = await this.engine.createSession(sName, workspace, task, {
              modelId,
              autoApproveRules: autoApproveRules as AutoApproveRules,
            });

            session.on("idle", () => {
              this.dispatchIdleNotification(session.name, session.status);
            });
            session.on("approvalRequest", () => {
              this.dispatchIdleNotification(session.name, session.status);
            });
            session.on("error", (err: any) => {
              this.dispatchErrorNotification(session.name, err);
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    sessionName: session.name,
                    cascadeId: session.cascadeId,
                    status: session.status,
                    createdAt: new Date().toISOString(),
                  }),
                },
              ],
            };
          }

          case "send_message": {
            const { session: sName, message, mode, modelId } = args as any;
            const session = this.engine.getSession(sName);
            if (!session) {
              throw new McpError(ErrorCode.InvalidParams, `Session not found: ${sName}`);
            }

            const result = await session.sendMessage(message, { mode, modelId });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    accepted: result.accepted,
                    droppedMessages: result.droppedMessages,
                    status: session.status,
                  }),
                },
              ],
            };
          }

          case "get_output": {
            const { session: sName, cursor } = args as any;
            const session = this.engine.getSession(sName);
            if (!session) {
              throw new McpError(ErrorCode.InvalidParams, `Session not found: ${sName}`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(session.getOutput(cursor)),
                },
              ],
            };
          }

          case "list_sessions": {
            const list = this.engine.listSessions().map((s) => {
              const out = s.getOutput();
              return {
                name: s.name,
                workspace: s.workspacePath,
                cascadeId: s.cascadeId,
                status: s.status,
                pendingApprovalsCount: out.pendingApprovals.length,
              };
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ sessions: list }) }],
            };
          }

          case "approve_step": {
            const { session: sName, stepIndex, scope } = args as any;
            const session = this.engine.getSession(sName);
            if (!session) {
              throw new McpError(ErrorCode.InvalidParams, `Session not found: ${sName}`);
            }

            await session.approveStep(stepIndex, scope);
            return {
              content: [{ type: "text", text: JSON.stringify({ approved: true, status: session.status }) }],
            };
          }

          case "deny_step": {
            const { session: sName, stepIndex } = args as any;
            const session = this.engine.getSession(sName);
            if (!session) {
              throw new McpError(ErrorCode.InvalidParams, `Session not found: ${sName}`);
            }
            await session.denyStep(stepIndex);
            return {
              content: [{ type: "text", text: JSON.stringify({ denied: true, status: session.status }) }],
            };
          }

          case "reset_session": {
            const { session: sName } = args as any;
            const session = this.engine.getSession(sName);
            if (!session) {
              throw new McpError(ErrorCode.InvalidParams, `Session not found: ${sName}`);
            }
            session.reset();
            return {
              content: [{ type: "text", text: JSON.stringify({ reset: true, status: session.status }) }],
            };
          }

          case "close_session": {
            const { session: sName } = args as any;
            await this.engine.destroySession(sName);
            return {
              content: [{ type: "text", text: JSON.stringify({ destroyed: true }) }],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (e: any) {
        if (e instanceof McpError) throw e;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: e.message || String(e),
              }),
            },
          ],
        };
      }
    });
  }

  /**
   * Dispatch notification when session shifts back to idle or waiting_user.
   */
  private dispatchIdleNotification(sessionName: string, status: string) {
    this.server.notification({
      method: "mcp-graviton/session_idle",
      params: {
        session: sessionName,
        status: status,
        summary: `Sub-agent completed execution step. Current status is ${status}.`,
      }
    }).catch(() => {
      // Ignore notification failures if connection channel is half-closed
    });
  }

  private dispatchErrorNotification(sessionName: string, err: any) {
    this.server.notification({
      method: "mcp-graviton/session_error",
      params: {
        session: sessionName,
        error: err?.message ?? String(err),
      },
    }).catch(() => {
      // Ignore notification failures if connection channel is half-closed
    });
  }

  public async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("mcp-graviton MCP Server running on stdio");
  }

  public async stop() {
    await this.server.close();
  }
}
