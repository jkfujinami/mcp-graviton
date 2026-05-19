/**
 * Spike 1: 基本フロー (診断モード)
 *   launch → startCascade → sendMessage → 全イベント観測 → 30秒後に状態ダンプ
 *
 * 1 回目の実行で response が来なかったので、何が起きているか可視化することに focus。
 *
 * 実行: npx tsx poc/spike-01-basic.ts
 */

import { AntigravityClient } from "antigravity-client";

const log = (label: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${label.padEnd(10)} ${msg}\n`);
};

async function main() {
  const killTimer = setTimeout(() => {
    log("timeout", "全体 timeout 120s、強制終了");
    process.exit(2);
  }, 120_000);

  log("init", "launch() 呼び出し中...");
  const client = await AntigravityClient.launch({
    workspacePath: process.cwd(), // 効いてないらしいが渡す
  });
  log("init", "launch 完了");

  try {
    const status = await (client as any).getUserStatus?.();
    log("init", `user: ${status?.userStatus?.name ?? "?"}`);
  } catch (e) {
    log("init", `getUserStatus 失敗: ${e}`);
  }

  log("init", "startCascade() 呼び出し中...");
  const cascade = await client.startCascade();
  log("init", `cascadeId = ${cascade.cascadeId}`);

  // ── ALL イベント (CascadeEvents.All) で全部見る ──
  cascade.on("all" as any, (ev: any) => {
    const event = ev?.event ?? "?";
    const data = ev?.data;
    // でかい payload は省略表示
    let summary = "";
    if (data) {
      if (data.delta) summary = `delta(${data.delta.length}ch)`;
      else if (data.step) summary = `step #${data.step.index} ${data.step.type}/${data.step.category} ${data.step.status}: ${data.step.description?.slice(0, 80) ?? ""}`;
      else if (data.status) summary = `${data.previousStatus} → ${data.status}`;
      else if (typeof data === "object") summary = JSON.stringify(data).slice(0, 120);
      else summary = String(data).slice(0, 120);
    }
    log("event", `${event} ${summary}`);
  });

  cascade.on("text", (ev: any) => process.stdout.write(`\x1b[36m${ev.delta}\x1b[0m`));
  cascade.on("thinking", (ev: any) => process.stdout.write(`\x1b[90m${ev.delta}\x1b[0m`));

  // ── sendMessage 投入 ──
  // model: 1133 = Gemini 3 Flash (SDK ハードコードの 1084 はもう存在しない)
  log("send", "「Hello」を送信 (model=1133)");
  const sendResp = await cascade.sendMessage("Hello, who are you? Reply briefly.", {
    model: 1133,
  } as any);
  log("send", `sendMessage return: ${JSON.stringify(sendResp).slice(0, 200)}`);

  // 30秒待つ。idle 検知ではなく時間で見る。
  log("wait", "30 秒イベント観測...");
  await new Promise((r) => setTimeout(r, 30_000));

  // ── 状態ダンプ ──
  log("dump", `current status = ${cascade.state.status}`);
  log("dump", `trajectory steps = ${cascade.state.trajectory?.steps?.length ?? 0}`);
  cascade.state.trajectory?.steps?.forEach((s: any, i: number) => {
    const kind = s.step?.case || "(none)";
    log("dump", `  step[${i}] kind=${kind} status=${s.status}`);
    if (s.error) {
      log("dump", `    error: ${JSON.stringify(s.error).slice(0, 200)}`);
    }
  });

  log("cleanup", "launcher.stop()");
  await (client as any).launcher.stop();
  clearTimeout(killTimer);
  log("cleanup", "終了");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
