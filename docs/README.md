# docs/

mcp-graviton の設計メモ置き場。固まった仕様ではなく、思考の整理用。

- [concept.md](./concept.md) — 何を作りたいか、なぜやるか
- [mcp-tools.md](./mcp-tools.md) — MCP として露出する 3 ツールの API スケッチ + 論点
- [lifecycle.md](./lifecycle.md) — セッションの状態機械、send/cancel/kill の意味、ワークスペース分離、永続化
- [coordination.md](./coordination.md) — idle 通知、ポーリングフォールバック、承認フロー、エラー契約、並列セッション
- [implementation-notes.md](./implementation-notes.md) — `antigravity-client/src/repl.ts` & `client.ts` から得た実装パターン (`startCascade()` 引数なし、`ApprovalRequest` ラッパー、LS プロセス vs workspace の関係など)

固まったら別途 `spec/` か README に格上げする。

## 検証必須な実機スパイク (実装着手前に潰すべき)

1. **MCP notification が Claude Code に届くか**: notification を出した時に model のターンに inject されるか。これ次第で「自然な非同期」 or 「ポーリング前提」に倒すかが決まる ([coordination.md §1, §2](./coordination.md))。
2. **`createCascade` の正確な署名**: 初期メッセージを create 時に注入できるか、別途 `sendMessage` で 1 手目を送る必要があるか ([lifecycle.md 末尾](./lifecycle.md))。
3. **interrupt → 即 send の整合性ラグ**: `cancel()` → `statusChange(canceling→idle)` → `sendMessage()` の動作確認 ([lifecycle.md `send_message` 節](./lifecycle.md))。
