# MCP ツール設計

最小構成は **3 つのツール** + **1 つの notification**。

---

## 決まったこと (固定)

- **接続方式は `AntigravityClient.launch()` 一本**。IDE 同居版は使わない。standalone で LS バイナリを SDK 側から立ち上げる前提。
- **セッションは長寿命の第一級オブジェクト**。Claude は 1 セッションを使い回して連続タスクを投げてよい。`create_session` は再利用前提で設計する。
- **interrupt の実装は `cascade.cancel()` → `sendMessage()` の 2 段**。`cascade.cancel()` は antigravity-client 側に既に実装あり (cascade.ts:832, `CancelCascadeInvocationRequest` を投げるだけ)。MCP server がこの 2 操作を 1 つの `send_message` 呼び出しの中で atomic にまとめる。
- **同期的な `wait_for_response` は廃止**。代わりに「セッションが idle に戻った時に MCP notification を出し、Claude は `get_output` でメッセージを取りに行く」非同期パターンに統一。

---

## 1. `create_session`

サブエージェントを 1 体起動する。Antigravity の Cascade を 1 本 launch する。

### 入力 (案)

| param | 必須 | 説明 |
|---|---|---|
| `name` | yes | セッションの識別名。後続呼び出しのキー。重複は禁止 or 自動 suffix。 |
| `task` | yes | 自然言語の初期タスク指示。Antigravity の Cascade 開始メッセージとして送る。 |
| `workspace` | yes | 作業ディレクトリの絶対パス。Antigravity の workspace ルート。 |
| `model` | no | `gemini-3-flash` 既定。 |
| `tools` | no | 有効化するツール群 (shell / web_search / file_edit / ...) のホワイトリスト。省略時は全部 ON。 |
| `auto_approve` | no | 危険操作の自動承認可否。デフォルトは保守的に false。 |

### 出力 (案)

```json
{
  "session_id": "string",
  "name": "string",
  "cascade_id": "string",
  "status": "running" | "idle",
  "created_at": "ISO 8601"
}
```

### 残論点

- **`name` を必須にするか自動採番にするか**。Claude が後で参照しやすいのは名前ベースなので必須寄り。
- **`task` 未指定で空セッション**を作って後で `send_message` で初期指示を送るパターンも許すか。
- **ワークスペース分離**: 同じディレクトリで複数セッションを立てた時の衝突対策 (git worktree を裏で切る案あり、ただし MVP 後)。
- **セッションの永続化**: MCP サーバー再起動で state が消えるのを許容するか、disk persist するか。MVP は揮発でいい気がする。

---

## 2. `send_message`

既存セッションへのメッセージ送信。`mode` で 2 系統。

### 入力 (案)

| param | 必須 | 説明 |
|---|---|---|
| `session` | yes | name or session_id |
| `message` | yes | 送る本文 |
| `mode` | no | `"queue"` (idle になるのを待ってから送る、デフォルト) / `"interrupt"` (実行中のターンを `cascade.cancel()` でキャンセルしてから即送る) |

### 出力 (案)

```json
{
  "accepted": true,
  "mode": "queue" | "interrupt",
  "status": "running" | "idle"
}
```

投げっぱなしで返す。応答を待ちたい場合は idle notification を受けてから `get_output` を呼ぶ。

### 残論点

- **queue モードの実装**: 内部キューで idle 待ちにするか、Antigravity LS 側に similar な機能があるならそれを使うか。前者が素直。
- **interrupt 後の挙動**: `cascade.cancel()` 直後に新メッセージを送る前にどれくらい待つ必要があるか (LS 側の状態整合)。要実機検証。
- **承認待ち (`requestedInteraction`) への応答**: send_message と統一するか、`respond_to_request` のような別ツールに切り出すか。MVP では `send_message` の特殊系として乗せられる気がする (mode を増やす or 自動判定)。

---

## 3. `get_output`

呼んだ瞬間のセッション出力スナップショットを返す。ポーリング型。

### 入力 (案)

| param | 必須 | 説明 |
|---|---|---|
| `session` | yes | name or session_id |
| `since` | no | カーソル (前回返した値)。これ以降の差分だけ返す。省略時は全部 or 最新だけ (要決定)。 |
| `format` | no | `"text"` (人間可読の要約) / `"steps"` (step 配列) / `"raw"` (生イベント) |

### 出力 (案)

```json
{
  "session": "name",
  "status": "running" | "idle" | "waiting_user" | "error",
  "cursor": "string",
  "steps": [ /* 直近 N step の要約 */ ],
  "text": "...",
  "artifacts": [
    { "path": "...", "change": "create" | "modify" | "delete" }
  ]
}
```

### 残論点

- **artifacts の取り方**: Antigravity の step 種別を types.ts のカテゴリマップ (`file_write` / `file_delete` / `file_move`) で振り分けて artifact リストを組む。具体的にどの step value を見れば path が取れるかは要調査。
- **長時間セッションのログ膨張**: cursor + ページングは必須。MVP では since カーソル必須・先頭からは取れない、で割り切ってもよい。
- **status の "waiting_user"**: cascade が `requestedInteraction` を出している状態を表す。Claude にこの状態を見せれば次に何を送るべきか自分で判断できる。

---

## 4. (notification) `session_idle`

ツールではなく、MCP server → client への **notification**。セッションが idle (= 1 ターン分の応答完了) に遷移したら自動で push する。

### ペイロード (案)

```json
{
  "session": "name",
  "session_id": "string",
  "status": "idle" | "waiting_user" | "error",
  "summary": "1〜2文の最新応答ヘッダ"  // claude が get_output 不要で済むよう、ヒントだけ載せる
}
```

### 残論点

- **Claude Code (MCP クライアント側) が notification を どう surface するか**。MCP プロトコル的には `notifications/message` か custom notification を投げられるが、Claude Code がこれを model に流すかは実装依存。要検証。
- **流さないなら**: 諦めて Claude にポーリングさせる (タイマー的な指示を CLAUDE.md に書く、or session list 取得用のツールを別途生やす)。

---

## 補助ツール (後回し候補)

- `list_sessions`: 現存セッション一覧 (status / 経過時間つき)
- `close_session`: idle 待ちで自然終了
- `kill_session`: 強制終了 (cancel + dispose)
- `get_artifacts`: 特定ファイルの最新内容取得

---

## 設計の根っこ

- **Claude は監督、Gemini は実働**。だから API は「指示を出す」「進捗を覗く」が主役。
- **完全非同期**。投げっぱなし + notification + ポーリング。同期 wait はやらない。
- **API は薄く**。Antigravity の機能全部は出さない。Claude が日常的に必要とする 3 動作 (起動 / 追加指示 / 覗き見) + idle 通知に絞る。
