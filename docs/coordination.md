# Claude ↔ サブエージェント 連携設計

Claude が「投げて、待たずに戻り、後で結果を回収する」非同期パターンを成り立たせるための仕掛け。

---

## 1. idle 通知の実装

### 何をフックするか

antigravity-client の `Cascade` は EventEmitter で `statusChange` を出す:

```ts
cascade.on("statusChange", ({ status, previousStatus }) => { ... });
```

`status === "idle" && previousStatus !== "idle"` の遷移が「1 ターン分の応答が完了した瞬間」。これを MCP notification の発火点にする。

### MCP 側でどう投げるか

MCP プロトコルにはサーバ → クライアントへの notification がある。最低限の選択肢:

- **`notifications/message`** (Log notification): 既存の汎用ログ通知。低コストで、Claude Code が UI に出すかは実装依存。
- **カスタム notification**: `mcp-graviton/session_idle` のような名前で出す。クライアントが知らない通知は無視される (規約)。
- **`notifications/resources/updated`** (Resource update): リソースとしてセッションを公開すれば、更新通知を Claude Code に投げられる。Claude Code がリソース通知を見ているかは要検証。

### 検証必須 (これが最大のリスク)

Claude Code が MCP server からの notification を **model のターンに surface するか** が分からない。可能性:

| ケース | 結果 |
|---|---|
| Claude Code が即時 inject する | 理想。Claude が通知をきっかけに `get_output` を呼ぶ流れが自然に成立 |
| UI に出すが model には流さない | 人間が見るだけ。Claude は自発的には反応しない |
| 完全に無視 | 後述のフォールバックに倒す |

→ 「ハロー、サンプル MCP で notification を投げる小実験」が **書く前に必要な最重要スパイク**。

---

## 2. notification が効かない場合のフォールバック

claude に「ポーリングしろ」と仕込む形に倒す。3 案:

### 案 A: ブロッキング `wait_for_idle` ツール

```
wait_for_idle(session, timeout_sec=300) → 戻るまでにブロック
```

- Claude がこのツールを呼ぶと MCP server 側で `statusChange → idle` を await。
- 戻り値は最新の出力サマリ。
- 欠点: ツール呼び出しが長時間 in-flight になる。Claude Code のタイムアウト挙動次第で破綻するかもしれない。

### 案 B: 軽量 `check_status` の連呼

```
check_status(session) → { status, has_new_messages, last_step_summary }
```

- Claude が間欠的に呼ぶ。
- 「Claude が `send_message` した直後に何度か `check_status` を叩く」運用を CLAUDE.md でガイド。
- 欠点: お行儀よくポーリングしてくれる保証がない。

### 案 C: notification ＋ Claude 側の reminder 注入

- notification は出す。届かなくても気にしない。
- CLAUDE.md に「サブを送ったら必ず後で `list_sessions` で進捗を見ろ」と書く。
- Claude 側のしつけと MCP 側の通知の二段構え。

**現実解**: 案 A (wait_for_idle) を実装しつつ notification も並行で投げる。Claude Code が拾えば早く動くし、拾えなくても wait_for_idle で同期できる。

---

## 3. 承認フロー (`requestedInteraction`)

Antigravity のステップは `requestedInteraction` を立てて承認待ちで止まることがある (e.g. `runCommand` の実行確認、`filePermission` の書き込み確認)。これを Claude に見せる必要がある。

### MCP 側のモデリング

`get_output` の戻り値の `status` に `waiting_user` が出たら、Claude は次のいずれかの判断:

- そのまま承認 → `approve_step` ツールを呼ぶ
- 拒否 → `reject_step` ツールを呼ぶ  
- 別の指示 → `send_message(mode="interrupt")` で割り込んで指示し直す

### `auto_approve` 設計

`create_session` の `auto_approve` を細かく設定可能にする:

```json
{
  "auto_approve": {
    "runCommand": false,          // shell は人 (Claude) に必ず確認
    "filePermission": "ONCE",     // ファイル操作は ONCE で都度許可
    "openBrowserUrl": false
  }
}
```

- bool だけだと粒度が足りない。case ごとに `false | "ONCE" | "ALWAYS"` の 3 値を指定できる形にしたい。
- 既定は **全部 false** (= 全部 Claude の判断を仰ぐ)。安全側に倒す。
- ただし「Claude にとっても監督コストが高いケース」(e.g. ls / cat みたいな完全 read-only コマンド) は、後でホワイトリスト的に自動 yes できる仕組みが要るかもしれない。MVP 後。

### approve / reject の MCP ツール案

```
approve_step(session, step_index?)   # step_index 省略時は現在の waiting step
reject_step(session, step_index?, reason?)
```

内部実装は `cascade.approveCommand` / `approveFilePermission` / `approveOpenBrowserUrl` / `sendInteraction` を interactionCase で振り分け。

---

## 4. エラーハンドリング契約

サブが転んだ時 Claude が次の手を打てるよう、エラーは **構造化して返す**。

### エラー分類

| 種類 | 例 | Claude が取るべき行動 |
|---|---|---|
| **transient** | LS との接続瞬断、API rate limit | 同じ session に再 send_message でリカバリ可 |
| **session_broken** | cascade が壊れた、LS が落ちた | 当該 session を kill して新規 create |
| **task_failed** | サブがタスクをやり切れず終了 | 指示を改めて新規 send_message |
| **permission_denied** | 危険操作で人手承認が必要 | `waiting_user` 状態に該当、`approve_step` で判断 |
| **fatal** | LS バイナリ起動失敗、認証切れ | mcp-graviton 全体の再起動 or 環境再確認 |

`get_output` / `send_message` の戻り値に `error: { kind, message, recoverable }` を載せる。

### LS プロセス監視

`AntigravityClient.launch()` で起動した LS が死んだ場合:

- 全 session が `closed` に遷移。
- MCP server は notification で全 Claude に「LS dead」を伝える。
- 復旧: 新規 `create_session` が来たら LS を再起動する lazy 戦略でいい (常時生存させる必要は薄い)。

---

## 5. 並列セッション

Claude が同時に複数セッションを動かすケース。

- 並列度の上限は **MVP では無制限** (実害が出るまで放置)。
- ただし `list_sessions` で全体が見えるようにし、Claude が自分で「今 N 個動いてるからこれ以上は止めとくか」を判断できる材料は出す。
- 後で `max_concurrent_sessions` の MCP 設定を生やせる余地は残す。

---

## 6. observability (人間向け)

開発時には人間も挙動を見たい。

- mcp-graviton のログを **stderr に構造化 JSON で出す**。Claude Code は MCP の stderr を拾うはず (要確認)。
- 各セッションの全 step を NDJSON でファイル書き出しするオプション (`MCP_GRAVITON_LOG_DIR=...`)。
- これは MVP には要らない。v0.2 で足す。

---

## 詰めきれていない最大の論点

1. **notification の到達性**: 実機スパイクで検証必須。これ次第で「いい感じの非同期」 or 「Claude にお行儀よくポーリングしてもらう」のどちらに倒すかが決まる。
2. **`createCascade` の初期メッセージ渡し方**: `task` を create 時に注入できるか、`sendMessage` で別途送る必要があるか。src/client.ts 精読タスク。
3. **interrupt 直後の send タイミング**: cancel → idle が落ちるまでのラグの正確値。実機でしか測れない。
