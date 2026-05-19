# mcp-graviton — コンセプト

## 一行で

Claude (Code) が Google Antigravity 上の Gemini 3 サブエージェントを生成・指揮できるようにする MCP サーバー。Claude は自然言語の指示出しと意思決定に集中し、トークン・コンテキストを食う実作業はサブエージェントに丸投げする。

## なぜやるか

- **Gemini 3 Flash は事実上「無限」に使える**。個々の知能は Claude より低いが、詳細に指示すれば十分な性能が出る。"安価で大量に使える IQ" は Claude 単体では絶対に得られない資源。
- **Claude の一番の制約は context window と token cost**。コーディング・調査・shell 実行のようにコンテキスト消費の激しいタスクをサブに移譲できれば、Claude は「指示と判断のレイヤー」に専念できる。
- **Antigravity LS は単なる LLM ラッパーではなくエージェント基盤**。セッション管理・Google Search 統合・shell 実行・ファイル編集が箱で用意されており、これを SDK 経由で握れば Claude の手足として極めて筋がいい。

## サブエージェントに任せたい仕事の例

- 詳細な指示に基づいたコーディング (実ファイル出力)
- 調査タスク (Google Search 統合があるので Web 探索を投げられる)
- shell でのビルド・実行・ログ収集
- 大量ログ・大量ファイルの要約 (Claude のコンテキストに乗せたくないもの)
- 同時並行で動かす独立タスク (PR 確認、テスト実行、ベンチマーク等)

Claude 側は最終的に「サブから上がってきた要約・成果物」だけを context に取り込めば良くなる。

## ユーザーフロー (理想形)

1. Claude が `create_session` でサブエージェントを起動。タスク内容・ワークスペースパス等を渡す。
2. サブエージェントが Antigravity LS 上で動き始める (Gemini 3 がプランニング → ツール実行 → ループ)。
3. Claude は必要に応じて `send_message` で追加指示・割り込みを送る。
4. Claude は `get_output` (仮称) で現在の状況をスナップショット取得し、完了判断・次の手を決める。
5. 成果物 (ファイル・要約・コード) は ワークスペース or レスポンスとして Claude に戻る。

## 既存の Claude Code サブエージェントとの違い

- Claude Code の `Agent` ツールは「もう一つの Claude」を呼ぶ仕組み。コストは Claude のまま。
- mcp-graviton は **異なるモデル・異なる経済性**のエージェントを呼ぶ。Claude のサブとしての位置付けというより、Claude が "監督" になり Gemini が "実働部隊" になる構造。

## スコープ外 (少なくとも初期)

- IDE 連携 (Antigravity IDE 自体との UI 統合)
- Antigravity 以外のバックエンド (OpenAI、Bedrock 等への一般化)
- mac 以外のプラットフォーム (antigravity-client が現状 macOS only)

## リスク・気をつけるところ

- **非公式 SDK**: antigravity-client は reverse-engineered。仕様変更で動かなくなる可能性。
- **長時間セッションの管理**: Antigravity LS はステートフル。MCP サーバー再起動時にどう復元するか (or 諦めるか) は要設計。
- **暴走サブエージェント**: shell とファイル編集を握っているので、サブが暴走すると実害が出る。最低限の制約 (workspace の物理的分離、停止コマンド) は必須。
- **トークンが「無限」とは言え API rate limit はある**。並列度の上限と back-off 戦略は別途必要。
