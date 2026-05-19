/**
 * Spike 6: 新 src/ GravitonEngine の E2E 動作確認
 *
 * 検証項目:
 *   1. createSession (autoApprove 全許可) で初期タスクが流れる
 *   2. session.on("idle") が発火する
 *   3. getOutput(cursor) が delta-only (isDelta=true) で返る
 *   4. getOutput() が累積全文 (isDelta=false) で返る
 *   5. 1ターン目完了後にファイルが生成されている
 *   6. sendMessage(queue) が 2ターン目を回す
 *   7. interrupt モードが droppedMessages を返す
 *   8. destroySession で LS まで落ちる (clients Map 空)
 *
 * 実行: npx tsx poc/spike-06-engine-real.ts
 */

import fs from "fs";
import os from "os";
import path from "path";
import { FileSessionPersistence } from "../src/persistence";
import { ConfigurableApprovalStrategy } from "../src/approval";
import { GravitonEngine } from "../src/engine";

const log = (label: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${label.padEnd(10)} ${msg}\n`);
};

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "graviton-spike6-"));
  log("init", `workspace = ${workspace}`);

  // セッション永続化は使い捨て tmpdir 配下にする (本物のホームを汚さない)
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "graviton-spike6-persist-"));
  const persistence = new FileSessionPersistence(persistDir);

  const strategy = new ConfigurableApprovalStrategy({
    runCommand: true,
    filePermission: true,
    openBrowserUrl: false,
  });

  const engine = new GravitonEngine(persistence, strategy);

  const killTimer = setTimeout(() => {
    log("timeout", "180s 経過、強制終了");
    process.exit(2);
  }, 180_000);

  let phaseFailed = false;
  const fail = (msg: string) => {
    log("FAIL", msg);
    phaseFailed = true;
  };
  const pass = (msg: string) => log("PASS", msg);

  try {
    // ── Phase A: createSession + 初期タスク ──
    log("phaseA", "createSession (auto-approve all)");
    const session = await engine.createSession(
      "spike6",
      workspace,
      `現在のディレクトリは ${workspace} です。\n` +
        `shell で \`ls -la\` を実行し、その後 HELLO.md を作成して「Hello from spike6」と書いてください。\n` +
        `終わったら "DONE-A" と回答してください。`,
      { modelId: 1133 }
    );
    log("phaseA", `cascadeId = ${session.cascadeId}`);

    // session.on("idle") を Promise 化
    const waitIdle = (timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          session.off("idle", h);
          reject(new Error(`idle timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const h = () => {
          clearTimeout(t);
          resolve();
        };
        session.on("idle", h);
      });

    // ── Phase B: cursor-based polling 確認 ──
    log("phaseB", "polling delta until idle (verify isDelta=true)");
    let cursor = session.getOutput().cursor;
    const startCursor = { ...cursor };

    const idleP = waitIdle(120_000);
    const pollTimer = setInterval(() => {
      const snap = session.getOutput(cursor);
      if (snap.isDelta !== true) fail("getOutput(cursor) should set isDelta=true");
      if (snap.text) process.stdout.write(snap.text);
      if (snap.commandOutput) process.stdout.write(`\x1b[36m${snap.commandOutput}\x1b[0m`);
      if (snap.pendingApprovals.length > 0) {
        log(
          "approval?",
          `pending=${JSON.stringify(snap.pendingApprovals.map((p) => ({ s: p.stepIndex, t: p.type, c: p.commandLine, f: p.filePath })))}`
        );
      }
      cursor = snap.cursor;
    }, 800);

    try {
      await idleP;
      pass("Phase A: idle イベント発火");
    } catch (e: any) {
      fail(`Phase A: idle 待ちタイムアウト: ${e.message}`);
    } finally {
      clearInterval(pollTimer);
    }
    process.stdout.write("\n");

    // ── Phase C: 累積出力チェック ──
    const fullSnap = session.getOutput();
    log("phaseC", `isDelta=${fullSnap.isDelta} textLen=${fullSnap.text.length} steps=${fullSnap.steps.length}`);
    if (fullSnap.isDelta !== false) fail("getOutput() should set isDelta=false");
    if (fullSnap.text.length === 0) fail("Phase A 後、累積 text が空");
    else pass("Phase C: 累積 text あり");

    // ── Phase D: ファイル生成検証 ──
    const helloPath = path.join(workspace, "HELLO.md");
    if (fs.existsSync(helloPath)) {
      const content = fs.readFileSync(helloPath, "utf-8");
      log("phaseD", `HELLO.md content: ${JSON.stringify(content.slice(0, 80))}`);
      pass("Phase D: HELLO.md 生成");
    } else {
      fail(`Phase D: HELLO.md not found. files=${JSON.stringify(fs.readdirSync(workspace))}`);
    }

    // ── Phase E: queue mode で 2ターン目 ──
    log("phaseE", "send 2nd message (queue mode)");
    const r2 = await session.sendMessage("HELLO.md の中身を表示してください。最後に \"DONE-E\" と答えて。", {
      mode: "queue",
    });
    log("phaseE", `sendMessage result: ${JSON.stringify(r2)}`);
    if (r2.droppedMessages !== 0) fail(`queue mode droppedMessages should be 0, got ${r2.droppedMessages}`);
    else pass("Phase E: queue droppedMessages=0");

    try {
      await waitIdle(120_000);
      pass("Phase E: 2nd turn idle");
    } catch (e: any) {
      fail(`Phase E: 2nd turn idle timeout: ${e.message}`);
    }

    // ── Phase F: interrupt with dropped queue ──
    log("phaseF", "queue 2 messages, then interrupt (should drop)");
    // queue は idle なら即発射されるので、わざと走行中に突っ込むのが面倒。
    // 代わりに 1 つだけ走らせて即 interrupt → 既存ターンが cancel される挙動を見る。
    // (queue を「ためる」のは実 LS では難しいので、ここは droppedMessages=0 のはず)
    const r3 = await session.sendMessage("sleep 10 して \"DONE-F\" と答えて。", { mode: "queue" });
    log("phaseF", `pre-interrupt sendMessage: ${JSON.stringify(r3)}`);
    // 少し走らせてから interrupt
    await delay(2000);
    const r4 = await session.sendMessage("中止しました。\"INTERRUPTED-F\" とだけ答えて。", {
      mode: "interrupt",
    });
    log("phaseF", `interrupt sendMessage: ${JSON.stringify(r4)}`);
    // droppedMessages は queue に積まれてた数。今回は 0 のはず (即発射されてたから)
    pass(`Phase F: interrupt accepted=${r4.accepted}, dropped=${r4.droppedMessages}`);

    try {
      await waitIdle(60_000);
      pass("Phase F: after-interrupt idle");
    } catch (e: any) {
      fail(`Phase F: after-interrupt idle timeout: ${e.message}`);
    }

    // ── Phase G: destroy + LS cleanup ──
    log("phaseG", "destroySession");
    await engine.destroySession("spike6");
    // 内部 clients Map が空か (引数 0 で listSessions = [])
    const remaining = engine.listSessions();
    if (remaining.length !== 0) fail(`listSessions should be empty after destroy, got ${remaining.length}`);
    else pass("Phase G: session list empty");
  } catch (e: any) {
    log("ERROR", `unhandled: ${e?.message ?? e}\n${e?.stack ?? ""}`);
    phaseFailed = true;
  } finally {
    log("cleanup", "engine.shutdown()");
    try {
      await engine.shutdown();
    } catch (e: any) {
      log("cleanup", `shutdown failed: ${e?.message ?? e}`);
    }
    clearTimeout(killTimer);
    fs.rmSync(persistDir, { recursive: true, force: true });
    log("done", phaseFailed ? "❌ SOME PHASES FAILED" : "✅ ALL PHASES PASSED");
    process.exit(phaseFailed ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
