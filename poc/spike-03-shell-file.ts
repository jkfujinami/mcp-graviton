/**
 * Spike 3: shell + file 操作 + ApprovalRequest + workspace 検証
 *
 *   - 一時 workspace を作って launch
 *   - Gemini に「ls してファイル数を README.md に書け」と頼む
 *   - ApprovalRequest を観測して全部自動承認
 *   - 完了後、想定 workspace にファイルが作られたか確認
 *
 * 実行: npx tsx poc/spike-03-shell-file.ts
 */

import { AntigravityClient, Cascade } from "antigravity-client";
import type { ApprovalRequest } from "antigravity-client";
import fs from "fs";
import os from "os";
import path from "path";

const MODEL_GEMINI_3_FLASH = 1133;

const log = (label: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${label.padEnd(10)} ${msg}\n`);
};

function waitForIdle(cascade: Cascade): Promise<void> {
  return new Promise((resolve) => {
    const handler = (ev: { status: string; previousStatus: string }) => {
      if (ev.status === "idle" && ev.previousStatus !== "idle") {
        cascade.off("statusChange", handler as any);
        resolve();
      }
    };
    cascade.on("statusChange", handler as any);
  });
}

async function main() {
  // 専用 workspace を作る (検証しやすいよう mcp-graviton 外)
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "graviton-spike-"));
  log("init", `workspace = ${workspace}`);

  const killTimer = setTimeout(() => {
    log("timeout", "180s 経過、強制終了");
    process.exit(2);
  }, 180_000);

  log("init", "launch() 呼び出し中...");
  const client = await AntigravityClient.launch({ workspacePath: workspace });
  log("init", "launch 完了");

  log("init", "startCascade()");
  const cascade = await client.startCascade();
  log("init", `cascadeId = ${cascade.cascadeId}`);

  // ── イベント配線 ──
  cascade.on("statusChange", (ev: any) =>
    log("status", `${ev.previousStatus} → ${ev.status}`)
  );

  cascade.on("stepNew", (ev: any) => {
    if (ev.step.category === "response") return; // text deltas で見るので省略
    log(
      "step+",
      `#${ev.step.index} ${ev.step.type}/${ev.step.category} [${ev.step.status}]: ${ev.step.description?.slice(0, 100) ?? ""}`
    );
  });

  cascade.on("stepUpdate", (ev: any) => {
    if (ev.step.category === "response") return;
    log("step~", `#${ev.step.index} ${ev.previousStatus} → ${ev.step.status}`);
  });

  cascade.on("text", (ev: any) =>
    process.stdout.write(`\x1b[36m${ev.delta}\x1b[0m`)
  );
  cascade.on("commandOutput", (ev: any) => {
    const c = ev.stream === "stderr" ? "\x1b[31m" : "\x1b[33m";
    process.stdout.write(`${c}${ev.delta}\x1b[0m`);
  });

  // ── ApprovalRequest を自動承認 ──
  cascade.on("interaction", async (req: ApprovalRequest) => {
    const r = req as any;
    log(
      "approve?",
      `type=${r.type} needs=${r.needsApproval} : ${r.description?.slice(0, 100) ?? ""}`
    );
    if (!r.needsApproval) return; // SDK が auto-run する旨だけ通知してきてる場合
    try {
      if (r.type === "file_permission") {
        await r.approve("conversation");
        log("approve+", `file_permission approved (conversation scope)`);
      } else {
        await r.approve();
        log("approve+", `${r.type} approved`);
      }
    } catch (e) {
      log("approve!", `approve failed: ${e}`);
    }
  });

  cascade.on("error", (err: any) => log("error", String(err)));

  // ── タスク投入 ──
  const task = [
    `現在の作業ディレクトリは ${workspace} です。`,
    `次の手順を実行してください:`,
    `1. シェルで \`ls -la\` を実行してこのディレクトリの中身を確認する。`,
    `2. README.md という名前のファイルを作成し、本文に「workspace: ${workspace}」と書き、その下に ls の結果を要約した1行を書く。`,
    `終わったら "DONE" と返事してください。`,
  ].join("\n");

  log("send", `タスク投入 (model=${MODEL_GEMINI_3_FLASH})`);
  await cascade.sendMessage(task, { model: MODEL_GEMINI_3_FLASH } as any);

  log("wait", "idle 待ち (最大 120s)...");
  await Promise.race([
    waitForIdle(cascade),
    new Promise<void>((r) => setTimeout(r, 120_000)),
  ]);

  // ── 結果検証 ──
  log("verify", "=== POST-TASK STATE ===");
  const files = fs.readdirSync(workspace);
  log("verify", `workspace files: ${JSON.stringify(files)}`);

  const readmePath = path.join(workspace, "README.md");
  if (fs.existsSync(readmePath)) {
    const body = fs.readFileSync(readmePath, "utf-8");
    log("verify", `README.md 存在: ${body.length}B`);
    log("verify", `--- README content ---\n${body}\n----------------------`);
  } else {
    log("verify", "README.md なし");
    // Antigravity の他の場所に出てないか確認
    log("verify", `cwd: ${process.cwd()}`);
    log(
      "verify",
      `cwd README.md: ${fs.existsSync(path.join(process.cwd(), "README.md"))}`
    );
  }

  log(
    "verify",
    `trajectory steps total = ${cascade.state.trajectory?.steps?.length ?? 0}`
  );
  const categories: Record<string, number> = {};
  cascade.state.trajectory?.steps?.forEach((s: any) => {
    const kind = s.step?.case || "(none)";
    categories[kind] = (categories[kind] ?? 0) + 1;
  });
  log("verify", `step kinds: ${JSON.stringify(categories)}`);

  // cleanup
  log("cleanup", "launcher.stop()");
  await (client as any).launcher.stop();
  clearTimeout(killTimer);
  log("cleanup", `workspace ${workspace} は残しておく (手動で確認可)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
