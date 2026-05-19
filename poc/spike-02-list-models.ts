/**
 * Spike 2: モデル ID を実機から取り出す
 *
 * SDK のデフォルト 1084 (MODEL_PLACEHOLDER_M84) が LS から "model not found" と
 * 返ってきていたので、現在 LS が知っているモデルを列挙する。
 */

import { AntigravityClient } from "antigravity-client";

async function main() {
  const client = await AntigravityClient.launch({
    workspacePath: process.cwd(),
  });

  console.log("--- getAvailableModels ---");
  try {
    const models = await (client as any).getAvailableModels();
    for (const [key, info] of Object.entries(models)) {
      console.log(key, JSON.stringify(info));
    }
  } catch (e) {
    console.log("getAvailableModels error:", e);
  }

  console.log("\n--- getModelStatuses ---");
  try {
    const statuses = await (client as any).getModelStatuses();
    console.log(JSON.stringify(statuses, null, 2).slice(0, 5000));
  } catch (e) {
    console.log("getModelStatuses error:", e);
  }

  await (client as any).launcher.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
