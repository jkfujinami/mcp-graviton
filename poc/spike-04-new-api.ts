/**
 * Spike 4: 新しい SDK API での確認
 *
 * - cascade.run(text) で 1 ターン実行 → 結果オブジェクトを受け取る
 * - 暗黙のモデル解決 (sendMessage に model 渡さない)
 * - client.resumeCascade(id) で再接続を試す
 * - interaction イベントが 1 回しか飛ばないことの確認
 * - MODEL_NAMES の使用
 *
 * 実行: npx tsx poc/spike-04-new-api.ts
 */

import { AntigravityClient, MODEL_NAMES } from "antigravity-client";
import type { ApprovalRequest } from "antigravity-client";
import fs from "fs";
import os from "os";
import path from "path";

const log = (label: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${label.padEnd(10)} ${msg}\n`);
};

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "graviton-spike4-"));
  log("init", `workspace = ${workspace}`);

  const killTimer = setTimeout(() => {
    log("timeout", "120s 経過、強制終了");
    process.exit(2);
  }, 120_000);

  log("init", "launch()");
  const client = await AntigravityClient.launch({ workspacePath: workspace });

  // モデル解決テスト
  const modelId = await client.resolveModelId(MODEL_NAMES.GEMINI_3_FLASH);
  log("init", `resolveModelId(GEMINI_3_FLASH) = ${modelId}`);
  const defaultId = await client.getDefaultModelId();
  log("init", `getDefaultModelId() = ${defaultId}`);

  log("init", "startCascade()");
  const cascade = await client.startCascade();
  log("init", `cascadeId = ${cascade.cascadeId}`);

  // interaction イベントが 1 回しか飛ばないことを観測
  let interactionCount = 0;
  cascade.on("interaction", (req: ApprovalRequest) => {
    interactionCount++;
    const hasApprove = typeof (req as any).approve === "function";
    log(
      "interact",
      `#${interactionCount} type=${(req as any).type} needs=${(req as any).needsApproval} hasApprove=${hasApprove}: ${(req as any).description?.slice(0, 80) ?? ""}`
    );
    if (hasApprove && (req as any).needsApproval) {
      (req as any).approve().catch((e: any) => log("interact!", `approve failed: ${e}`));
    }
  });

  cascade.on("stepNew", (ev: any) => {
    if (ev.step.category !== "response") {
      log(
        "step+",
        `#${ev.step.index} ${ev.step.type}/${ev.step.category} [${ev.step.status}]`
      );
    }
  });

  // ★ 高レベル API: cascade.run()
  log("run", "cascade.run() で 1 ターン実行 (model指定なし=デフォルト解決)");
  const result = await cascade.run(
    `現在のディレクトリは ${workspace} です。\nshell で \`ls -la\` を実行して中身を確認し、HELLO.md を作成して「Hello, mcp-graviton!」と書いてください。終わったら "DONE" と答えてください。`,
    { timeoutMs: 90_000 }
  );

  log("run", `text length = ${result.text.length}`);
  log("run", `newSteps = ${result.newSteps.length}`);
  log("run", `finalStatus = ${result.finalStatus}`);
  log("run", `timedOut = ${result.timedOut}`);
  log("run", `interaction events fired total = ${interactionCount}`);
  log("run", "--- assistant text ---");
  console.log(result.text);
  log("run", "----------------------");

  // ファイル確認
  const helloPath = path.join(workspace, "HELLO.md");
  if (fs.existsSync(helloPath)) {
    log("verify", `HELLO.md created: ${fs.readFileSync(helloPath, "utf-8").slice(0, 100)}`);
  } else {
    log("verify", `HELLO.md NOT created. workspace files: ${JSON.stringify(fs.readdirSync(workspace))}`);
  }

  // 2 ターン目: 既存セッションを使い回し
  log("run2", "同じ cascade で 2 ターン目");
  const result2 = await cascade.run("今作ったファイル名を教えてください。", {
    timeoutMs: 30_000,
  });
  log("run2", `text = ${result2.text.slice(0, 200)}`);
  log("run2", `newSteps = ${result2.newSteps.length}`);

  // resumeCascade テスト
  const savedId = cascade.cascadeId;
  log("resume", `cascadeId 保存: ${savedId}`);
  const cascade2 = await client.resumeCascade(savedId);
  log("resume", `resumeCascade 成功. trajectory steps = ${cascade2.state.trajectory?.steps.length ?? 0}`);

  // cleanup
  log("cleanup", "client.dispose()");
  client.dispose();

  log("cleanup", "launcher.stop()");
  await (client as any).launcher.stop();
  clearTimeout(killTimer);
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
