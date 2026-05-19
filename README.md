# mcp-graviton

Claude Code から Google Antigravity 上の Gemini 3 Flash サブエージェントを生成・指揮するための MCP サーバー + CLI

## なぜ作ったか

- **Gemini 3 Flash を「無限の作業員」として活用**: 個々の知能は Claude より低いものの、詳細な指示を与えることで十分な性能を発揮します。
- **Claude のコンテキストとトークンコストの削減**: コーディングや調査、Shell 実行といったコンテキスト消費の激しい実作業をサブエージェントに委譲し、監督・判断のレイヤーに専念させます。
- **Antigravity LS を基盤とした手足の獲得**: セッション管理、Google Search 統合、Shell 実行、ファイル編集などの実用ツールを SDK 経由で Claude の手足として自在に操ることができます。

## アーキテクチャ

3 層のコンポーネントで構成されています。

- **antigravity-client**: Google Antigravity の Language Server (LS) プロセスを起動・接続し、各種操作や状態の監視を行う SDK。
- **GravitonEngine / GravitonSession**: `src/engine.ts` と `src/session.ts` に実装されたコアレイヤー。LS プロセスライフサイクルやセッション（1 Session = 1 Cascade）のキュー処理・状態機械を制御。
- **2 つのフロントエンド**:
  - **(a) MCP stdio サーバー**: Claude Code 等から標準入出力経由で接続可能な MCP 準拠のインターフェース (`src/server.ts`)。
  - **(b) Unix socket daemon + CLI**: バックグラウンドでセッション状態を維持する Unix ソケットデーモン (`src/daemon.ts`) と、ターミナルから直接セッション操作を行うための CLI ツール (`src/cli.ts`)。

## MCP ツール

`src/server.ts` に登録されている 8 つのツールの一覧です。

| ツール名 | 必須引数 | 用途 |
|---|---|---|
| `create_session` | `name`, `task`, `workspace` | 指定したワークスペース上で Google Antigravity サブエージェントセッションを新規起動する。 |
| `send_message` | `session`, `message` | 実行中のセッションに対して、追加の指示やタスクを送信する。 |
| `get_output` | `session` | セッションの出力テキスト、思考プロセス、実行されたステップ、およびユーザー承認待ちの状態のスナップショットを取得する。 |
| `list_sessions` | なし | 現在管理されているセッションの一覧を取得する。 |
| `approve_step` | `session`, `stepIndex` | ユーザー承認待ち（`waiting_user`）で一時停止しているステップを承認し、続行させる。 |
| `deny_step` | `session`, `stepIndex` | ユーザー承認待ち（`waiting_user`）で一時停止しているステップを拒否する。 |
| `reset_session` | `session` | セッションのエラー状態をリセットし、`idle` 状態に戻して新しい指示を受け付けられるようにする。 |
| `close_session` | `session` | セッションを安全に終了し、割り当てられたメモリやリソースを解放する。 |

## CLI (graviton コマンド)

`graviton` コマンドを使用することで、デーモンとやり取りして直接サブエージェントセッションを制御できます。

### 代表的なサブコマンドと使用例

```bash
# デーモンの起動（バックグラウンド実行）
graviton daemon &

# 新しいセッションの作成（ワークスペース、初期タスク、自動承認ルールなどを指定）
graviton create my-sess --workspace /Users/fujinami/github/mcp-graviton --task "Fix the build errors and format the code" --auto-shell --auto-file --model 1133

# セッション情報の取得（進捗や承認待ち状況）
graviton get my-sess

# セッションから出力されるイベント通知のリアルタイム監視（ストリーム）
graviton watch my-sess

# デーモンのシャットダウン
graviton stop
```

### デーモンの挙動とソケット
- デーモンのソケットファイルおよび各種 PID は `~/.mcp-graviton/daemon.sock` や `~/.mcp-graviton/daemon.pid` に配置されます。
- `graviton stop` もしくはデーモンへの `shutdown` リクエストを実行すると、デーモンは動作中の全 Engine セッションおよび起動した LS プロセスを含めて安全にシャットダウンされ、ソケットファイル等のリソースがクリーンアップされます。

## インストール / セットアップ

### 1. 依存関係のインストール
```bash
npm install
```
> [!NOTE]
> `package.json` において `antigravity-client` は `"file:../antigravity-client"` としてローカル参照されています。そのため、ビルドや実行を行うには隣接するディレクトリに `antigravity-client` リポジトリが配置されている必要があります。

### 2. ビルドの実行
```bash
npm run build
```
これにより TypeScript がコンパイルされ、`dist/` ディレクトリ以下に JavaScript ファイルが出力されます。

### 3. Claude Code への登録
`.mcp.json` に以下のように登録して、MCP サーバーとして利用可能にします。

```json
{
  "mcpServers": {
    "mcp-graviton": {
      "command": "node",
      "args": ["/Users/fujinami/github/mcp-graviton/dist/index.js"]
    }
  }
}
```

## セッション状態

セッション（Cascade）は、ライフサイクルにおいて以下の状態遷移を行います。

- `idle`: 直前のターン（ステップ）の実行が完了し、次の追加入力（指示）を待っている状態。
- `running`: サブエージェント（Gemini 3）が思考中、または指示されたツール（Shell、ファイル操作等）を実行中の状態。
- `busy`: LS プロセスの内部処理中で、一時的にビジーになっている状態。
- `canceling`: メッセージの割り込み送信（`interrupt`）などにより、実行中のターンをキャンセルして `idle` 状態に戻る過渡状態。
- `waiting_user`: コマンド実行やファイル書き込みなど、危険な操作を行うためにユーザーの承認（`approve_step`）を待っている状態。
- `error`: ターンの実行中に致命的なエラーが発生し、処理が停止した状態。
- `closed`: セッションが明示的に破棄された、もしくは LS プロセスが切断された状態。

## 注意点

- **antigravity-client の参照**: SDK である `antigravity-client` は、ローカル（`../antigravity-client`）もしくは `github:jkfujinami/antigravity-client` 等から取得されます。LS (Language Server) のモデル ID は今後変更される可能性があるため、実装内部では `resolveModelId` を介して適切に ID 解決が行われます。
- **セッション永続化先**: デーモン経由で管理されるセッションメタデータは、`~/.mcp-graviton/sessions/*.json` に JSON ファイルとして永続化されます。デーモン起動時に自動で読み込まれ、既存のセッションが再開されます。
- **1 ワークスペース = 1 LS プロセス**: 同じワークスペースに対する複数セッションは、内部の `GravitonEngine` によってプール管理された 1 つの LS プロセスを共有します。

## 開発

- **ビルドコマンド**: `npm run build` (tsc によるビルド)
- **主要なスパイクファイル (PoC)**:
  - `poc/spike-04-new-api.ts`: 新しい SDK API を用いた接続・操作検証
  - `poc/spike-06-engine-real.ts`: 実際の Engine クラスを用いたバックエンド動作検証
- **設計資料**: `docs/` ディレクトリ配下に設計思想 (`concept.md`)、ライフサイクル (`lifecycle.md`)、連携・承認フロー (`coordination.md` / `mcp-tools.md`) 等の設計書が格納されています。
