# 実装ノート (antigravity-client 由来)

`antigravity-client/src/repl.ts` と `client.ts` を読んで得た、実装に直接効く知見。  
設計ドキュメントが「こうしたい」を書くのに対し、ここは「実際に使える API はこうなっている」を書く。

---

## 1. セッション生成のシグネチャ

```ts
const client = await AntigravityClient.launch({ workspacePath: "/foo/repo" });
const cascade = await client.startCascade();   // ← 引数なし
await cascade.sendMessage("最初の指示");          // ← 初期タスクはここで送る
```

- `startCascade()` は **引数を取らない**。Cascade を空で生成する。
- 初期タスク (= `create_session` の `task` 引数) は、生成直後に `sendMessage()` で 1 手目として送る形になる。
- model 指定は `sendMessage(text, { model: 1084 })` で渡す (Gemini 3 Flash = 1084 がデフォルト)。
- `cascade.listen()` は `startCascade()` / `getCascade()` の内部で auto-call される。我々が呼ぶ必要なし。

### MCP 側のマッピング

```
create_session({ name, task, workspace, model, tools, auto_approve })
  ↓
1. workspace に対応する AntigravityClient を取得 or launch
2. cascade = await client.startCascade()
3. await cascade.sendMessage(task, { model })
4. session registry に { name, cascade, cascadeId, workspace, ... } を登録
5. cascade.on(...) で event listener を貼る
```

---

## 2. LS プロセスと workspace の関係

**重要な制約**: `AntigravityClient.launch({ workspacePath })` で **workspace は LS プロセスに紐づく**。1 つの client (= 1 つの LS プロセス) は 1 つの workspace しか扱えない。

→ 複数 workspace を扱うなら **LS プロセスのプール** が必要。

### 推奨パターン

mcp-graviton の中に `Map<workspacePath, AntigravityClient>` を持つ:

```ts
class GravitonRegistry {
  private clients = new Map<string, AntigravityClient & { launcher: Launcher }>();
  private sessions = new Map<string, SessionMeta>(); // by session name

  async getOrLaunchClient(workspace: string) {
    const norm = path.resolve(workspace);
    if (!this.clients.has(norm)) {
      this.clients.set(norm, await AntigravityClient.launch({ workspacePath: norm }));
    }
    return this.clients.get(norm)!;
  }
}
```

- 同じ workspace への複数セッションは同じ client (= 同じ LS) を共有。
- workspace が違えば LS をもう 1 つ launch する。
- LS プロセスは「その workspace 上の最後のセッションが消えたら `launcher.stop()`」で片付ける。

---

## 3. セッション復元 (永続化を安く)

```ts
const cascade = client.getCascade(savedCascadeId);  // 同期で Cascade ref 返る
await cascade.getHistory();                          // 存在確認 + 履歴 load
```

`getCascade()` は LS 側に問い合わせず、ローカルで `new Cascade(...)` するだけ。`getHistory()` を呼んで初めて LS と通信し、生きているか確認できる。

### MCP 側のメリット

- mcp-graviton が再起動しても、`cascadeId` を disk に append しておけば `attach_session({ cascade_id })` で全セッション復元可能。
- repl.ts は `.last_cascade_id` ファイルに 1 つだけ書いている。我々は per-session 単位で `~/.mcp-graviton/sessions/{name}.json` に書けばよい。
- **MVP に含めて良い**。docs/lifecycle.md の永続化セクションは「v0.2 に回す」と書いたが格上げできる。

---

## 4. 高レベル Event の一覧 (実装で使う側)

`Cascade.Events` (= `CascadeEvents`) の主要メンバー。repl.ts で実証済み。

| Event | ペイロード | 用途 |
|---|---|---|
| `StatusChange` | `{ status, previousStatus }` | 状態機械の正本。`idle` 遷移検知 |
| `Done` | `{}` | `IDLE` 遷移のレガシーエイリアス。StatusChange で代替可 |
| `StepNew` | `{ step }` | 新ステップ開始。`step.description` / `step.category` / `step.status` / `step.index` |
| `StepUpdate` | `{ step, previousStatus }` | ステップ状態遷移 |
| `Text` | `{ delta }` | アシスタント出力テキストのストリーム |
| `Thinking` | `{ delta }` | 思考トークンのストリーム |
| `CommandOutput` | `{ stream: "stdout"\|"stderr", delta }` | shell 実行のストリーム |
| `Interaction` | `ApprovalRequest` | 承認待ちの発生 (後述) |
| `Error` | `err` | ターン中のエラー |
| `RawUpdate` | `state` | 生 state (デバッグ専用、大きい) |

→ `get_output` の戻り値を組み立てるときは、内部で `StepNew`/`StepUpdate`/`Text` を蓄積したバッファから引けばよい。

### イベントが実は cascade に 2 重に乗っていることに注意

cascade.ts の `emit` は「個別 step イベント」も自動で発火する: `step:runCommand` のような形で。MCP 側で個別ステップに反応する必要はほぼないが、後で特定 step を pinpoint で処理したいときの逃げ道として覚えておく。

---

## 5. 承認フローは ApprovalRequest にラップ済み

最大の発見。`Events.Interaction` のペイロードは raw な `requestedInteraction` ではなく、SDK がラップした **`ApprovalRequest`**:

```ts
interface ApprovalRequest {
  needsApproval: boolean;          // false なら SDK が自動実行する旨の通知のみ
  description: string;             // 人間可読の説明 (例: "Run command: ls -la")
  type: "run_command" | "file_permission" | "open_browser_url" | ...;
  approve(scope?: "once" | "conversation"): Promise<void>;
  // reject や deny も恐らくあるはず、要確認
}
```

### MCP 側で何をすればいいか

`coordination.md` で書いた「`requestedInteraction.case` で `approveCommand` / `approveFilePermission` を振り分ける」は不要。SDK が振り分けて `request.approve()` 1 つに集約してくれる。

MCP の `approve_step` ツールはこれを直接呼ぶだけ:

```ts
// MCP server 内部
const pending = sessionMeta.pendingApprovals.get(stepIndex);
await pending.request.approve(scope);  // scope = "once" | "conversation" | undefined
```

`type === "file_permission"` のときだけ scope を選べる、それ以外は引数なし `approve()`、という仕様 (repl.ts の `handlePermissionRequest` vs `handleSimpleApproval` の分岐そのまま)。

### `needsApproval: false` の扱い

`Interaction` イベントは「自動実行されるよ」というケースでも飛んでくる (`needsApproval: false`)。これは:

- MCP 側では **無視 or ログだけ**。`approve_step` の対象にはしない。
- ただし `get_output` のサマリには「自動実行: ls -la」を出した方が Claude にとって透明性が増す。

### `reject` の手段

repl.ts では「Deny」時にただログを出して何もしていない。これは Antigravity 側で「承認待ちを放置すると idle に戻る」挙動を期待しているっぽいが、要確認。明示的に reject する API が必要なら `sendInteraction(stepIndex, ..., { allow: false })` 系で投げる必要があるかも。**スパイクで確認すべき項目**。

---

## 6. Step のリッチさを活用する

`StepNew` / `StepUpdate` の payload (`ev.step`) は `CascadeStep` クラスのインスタンスで、以下が取れる:

| プロパティ | 中身 | 例 |
|---|---|---|
| `step.index` | trajectory 内の連番 | `0`, `1`, `2` ... |
| `step.type` | StepType 文字列 | `"runCommand"`, `"writeToFile"` |
| `step.status` | StepStatus | `"running"`, `"done"`, `"error"` |
| `step.category` | StepCategory (types.ts の map) | `"command"`, `"file_write"`, `"response"` |
| `step.description` | 人間可読の説明 | `"Run command: npm test"` |
| `step.value` | 生の Step value (型安全に取れる) | `CortexStepRunCommand` インスタンス |

### MCP の get_output サマリ

```json
"steps": [
  {
    "index": 0,
    "type": "userInput",
    "category": "user_input",
    "status": "done",
    "description": "User: 最初の指示"
  },
  {
    "index": 1,
    "type": "runCommand",
    "category": "command",
    "status": "running",
    "description": "Run command: npm test"
  }
]
```

`step.description` をそのまま `summary` 候補にできる。

### artifact 抽出

`step.category === "file_write" | "file_delete" | "file_move"` で artifact 候補をフィルタし、`step.value` から `path` を取り出す。具体的にどのフィールドが path かは step.type ごとに違うので個別実装が要る (例: `writeToFile.path`, `fileChange.path`, etc.)。

→ MVP では `category` フィルタだけで「ファイル操作があった step の一覧」を出し、path の正確な抽出は v0.2 で詰める案もアリ。

---

## 7. listener 管理

repl.ts では新セッション開始時に `state.cascade.removeAllListeners()` を呼んでいる。

MCP 側でも同じ運用が必要:

- `kill_session` / `close_session` で必ず `removeAllListeners()` を呼ぶ。
- そうしないと session を捨てた後も古い listener が動き続け、message が宙に浮く。

---

## 8. repl.ts と mcp-graviton の対応表

| repl.ts | mcp-graviton |
|---|---|
| `init()` で `connect()` | server 起動時に何もしない (lazy launch) |
| `startNewSession()` | `create_session` ツール |
| `cascade.sendMessage(input)` | `send_message` ツール (queue mode) |
| (なし — interrupt は対話的 SIGINT) | `send_message` ツール (interrupt mode) → `cascade.cancel()` + `sendMessage` |
| `Events.Text` / `Thinking` / `CommandOutput` を即 process.stdout に書く | バッファに蓄積 → `get_output` で取り出し |
| `Events.Done` で readline prompt | `statusChange → idle` で MCP notification |
| `Events.Interaction` → `askQuestion()` で標準入力待ち | `pendingApprovals` map に積む → `get_output` で `waiting_user` 状態を返す → Claude が `approve_step` を呼ぶ |
| `.last_cascade_id` ファイル | `~/.mcp-graviton/sessions/{name}.json` (per-session) |
| `getCascade(savedId).getHistory()` で復元 | `attach_session` ツール (optional) |
| `/new`, `/exit` slash commands | `close_session` / `kill_session` ツール |

---

## 残るスパイク項目 (実装前に潰す)

1. **MCP notification の到達性** (Claude Code 側が model に流すか)。← 最重要
2. **`reject` の正式手段**: ApprovalRequest に `reject()` がなければ `sendInteraction(allow:false)` 系で代用できるか。
3. **`cancel()` 後の `sendMessage` タイミング**: `statusChange(canceling→idle)` を待てば十分か、追加のラグが必要か。
4. **`launch()` で立てた LS のクラッシュ検知**: `launcher` から exit イベントが取れるか (= プロセス監視の足回り)。
