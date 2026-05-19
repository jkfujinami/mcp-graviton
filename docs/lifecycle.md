# セッション ライフサイクル

mcp-graviton におけるセッション = Antigravity の **1 つの Cascade**。長寿命・使い回し前提。

---

## 状態機械

ベースは Antigravity 側 `CascadeRunStatus` を素直に写す。

| 状態 | 元 enum | 意味 | MCP 側からの遷移トリガー |
|---|---|---|---|
| `idle` | `IDLE` | 直前のターン完了。次の入力待ち | `send_message` 受信 |
| `running` | `RUNNING` | Gemini が思考 or ツール実行中 | (自動) |
| `busy` | `BUSY` | 内部処理中 (LS 側都合) | (自動、短期) |
| `canceling` | `CANCELING` | `cancel()` 投入後、idle に落ちる前の過渡 | `interrupt` 投入時 |
| `waiting_user` | (`requestedInteraction` あり) | 承認待ち | (自動) — Antigravity の status enum には無いが mcp-graviton で派生 |
| `error` | (`status.error` あり) | ターン失敗 | (自動) |
| `closed` | (LS 切断 or 明示的 close) | 終了 | `close_session` / `kill_session` |

`waiting_user` と `error` は antigravity-client の素のステータスには無い派生状態。mcp-graviton 側で **`Cascade.state.trajectory.steps` の末尾 step を見て合成する**。

### 遷移図 (ざっくり)

```
                     send_message
              ┌──────────────────────────┐
              ▼                          │
   ┌──>  idle ──> running ──> idle  ─────┘
   │              │  │
   │              │  └──> waiting_user ──(approve/reject)──> running
   │              │
   │              └──> error  (送信側で要回収)
   │
   │       interrupt
   └── canceling <── any state above
```

---

## API の地に足ついたマッピング

antigravity-client 側で握れる関数は以下。これを MCP ツールから素直に呼ぶ。

| やりたいこと | antigravity-client API | 備考 |
|---|---|---|
| Cascade 起動 | `AntigravityClient.launch({ workspacePath, verbose })` → `client.createCascade(...)` | 要 src/client.ts 精読 (`createCascade` の正確な署名は別途確認、ここの調査は MVP 実装前に潰す) |
| メッセージ送信 | `cascade.sendMessage(text, { model })` | `blocking: false` 内蔵。即 return。応答はイベントで届く。 |
| 中断 | `cascade.cancel()` | `CancelCascadeInvocationRequest` を投げる。await 後でも実際に状態が落ちるまで多少ラグあり (canceling 経由) |
| 履歴取得 | `cascade.getHistory()` | `GetCascadeTrajectoryRequest`。startup 時の state 復元にも使える |
| 承認 (run command) | `cascade.approveCommand(stepIndex, cmd)` | requestedInteraction.case = "runCommand" or "permission" を捌く |
| 承認 (file write) | `cascade.approveFilePermission(stepIndex, uri, scope)` | scope = `ONCE` / `ALWAYS` |
| 承認 (browser url) | `cascade.approveOpenBrowserUrl(stepIndex)` | |
| 任意の interaction | `cascade.sendInteraction(stepIndex, case, value)` | 上記でカバーできない時の汎用エスケープ |
| 終了 | `client.launcher.stop()` | launch() で立てた LS プロセスごと落とす |

---

## `send_message` の queue / interrupt 実装

- **queue mode** (デフォルト):
  - MCP server 側の per-session queue に push。
  - 現在 `idle` なら即 `cascade.sendMessage()` を呼ぶ。
  - `running` / `busy` / `canceling` なら、`statusChange` イベントで `idle` になった瞬間に dequeue → 送信。
  - キューが空の `idle` で次の send が来たら即送信。

- **interrupt mode**:
  - `await cascade.cancel()` → `statusChange` で `canceling → idle` を待つ → `cascade.sendMessage(newText)`。
  - キャンセル後の整合性ラグは要実機検証だが、`statusChange` を待つだけで足りるはず (Antigravity 側の責務)。
  - キューに残った queue モードのメッセージは **interrupt が来た時点で破棄** を仮の方針とする。残すと意図しない順序で実行されかねない。

---

## kill / close の意味分け

- **`close_session`**: 「もう使わないので片付ける」。idle になるまで待ってから dispose。記録は残す (history は引ける)。
- **`kill_session`**: 「いま強制終了」。`cascade.cancel()` → 短時間で idle 待ち → state を破棄。応答待ちのキューも全部捨てる。

両方とも最後は **session レジストリから外す** だけで、LS プロセスは生存させる (他のセッションが居る可能性)。LS プロセス自体を落とすのは「最後のセッションが消えたタイミング」か「明示的な MCP shutdown」のみ。

---

## ワークスペース分離

問題: Claude が `workspace=/foo/repo` で複数セッションを立てた時、両方が同じ git working tree を触ると衝突する。

選択肢:

1. **ナイーブ案 (MVP)**: 同一 workspace への複数セッションを許す。衝突は Claude 側の責任。シンプル。
2. **git worktree 自動**: `create_session` で `workspace` が git repo の場合、裏で `git worktree add` を切ってサブに渡す。`close_session` で worktree を畳む。実装コストはあるが事故が激減する。
3. **強制排他**: 同じ workspace のセッションは 1 つだけ。2 つ目の create は error。安全だが使い物にならないかも。

**初期は (1) で開始**。session メタ情報に workspace を持っておけば、後で (2) に移行できる。

---

## 永続化

MVP: **揮発**。MCP server プロセスが死ぬとセッション一覧は消える。

回復の余地:
- Antigravity LS 側に cascade は残っているので、`cascade_id` さえ知っていれば `getHistory()` で復元可能。
- そのため `cascade_id` を **disk に append-only で記録** しておくだけで「サーバ再起動後にも前回の cascade を `attach_session` で取り戻せる」拡張は安く実現できる。これは v0.2 以降の課題として置く。

---

## まだ詰めるべきところ

- **`createCascade` の正確な署名**: src/client.ts を読んで初期メッセージの渡し方 (`task` をどう注入するか) を確定する。`sendMessage` で 1 手目を送る形か、create 時に system 相当を入れられるか。
- **interrupt 後のキュー処理**: 「破棄」で良いか、Claude に「破棄したメッセージ一覧」を返した方が誠実か。
- **`approveCommand` の自動承認方針**: `auto_approve=true` のときに全 interactionCase を自動 yes にして良いか。例えば `filePermission` は scope=ONCE で OK、`openBrowserUrl` は確認したい、など粒度設計が要る。
