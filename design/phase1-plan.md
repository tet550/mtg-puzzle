# Phase 1 実装計画 — パズルプレイヤー（2026-10-19）

要件: [requiremnts.txt](requiremnts.txt) の「10. 開発フェーズ 2. Phase 1」
前提: [phase0-summary.md](phase0-summary.md)。Phase 0 は通過したものとして扱う（CheerpJ 4.3 + Worker 版、forge-ai なし）。

## 0. ゴールと範囲

**ゴール**: 固定のサンプル問題をブラウザで開き、独自の UI で操作してクリアできる。PC とスマートフォンの両方で操作できる。

| 範囲に含める | 範囲に含めない（後のフェーズ） |
|---|---|
| サンプル問題の一覧と選択（ビルド時に同梱） | 盤面エディタ（Phase 2） |
| 盤面表示（PC / スマホのレイアウト） | URL 共有（Phase 3） |
| 選択要求への回答 UI（優先権・対象・攻撃・確認・マナ・コスト） | 任意のカードを動的に読み込む（Phase 2 の前提として調査だけする） |
| クリア / 失敗の判定と表示、リセット | Undo、解答手順の記録 |
| エンジンの準備中の表示、異常時の表示と復帰 | Cloudflare Pages への公開（P1・P3 の結論が出るまで保留） |
| Forge の `.pzl` からサンプル問題への変換（ビルド時のツール） | カード画像（V7 の利用規約の確認が済むまでテキスト表示） |

### Phase 1 の完了条件

1. サンプル問題を 10 問以上同梱し、すべてクリアできる（E2E テストで自動確認）。fallbackLog が空であること。
2. PC の Chrome / Safari、iOS Safari、Android Chrome で、タップだけで最後まで操作できる。
3. 準備完了までの時間を PC と実機で計測し、記録する（目標: PC 2 回目以降 3 秒、スマホ初回 15 秒以内）。
4. エンジンの例外・タイムアウト・不正な問題データで、UI が止まらずにエラーを表示し、リセットか再読み込みで復帰できる。
5. Adapter API の仕様を `design/adapter-api.md` に残す（Phase 0 の A7）。

## 1. 構成

```
app/                          … 新規。Vite + TypeScript（フレームワークなし、または Preact）
  src/
    engine/                   … Forge Adapter（TS 側）
      protocol.ts             … Worker とのメッセージ型、Adapter API の型（GameView / Decision / Event）
      client.ts               … ForgeEngine 実装。RPC、タイムアウト、再起動、準備状況の通知
      worker.js               … classic Worker。CheerpJ の loader.js を importScripts する
    puzzle/                   … Puzzle Core
      schema.ts               … 問題データの型と検証（schemaVersion 1）
      judge.ts                … クリア判定（イベント列 → 結果）。純粋関数
      session.ts              … 進行状態（読み込み中 / 操作中 / クリア / 失敗 / エラー）
      catalog.ts              … 同梱サンプル問題の一覧
    ui/                       … 盤面・カード・選択要求・結果・ログ
  public/engine/              … ビルド時に配置: forge-adapter-min.jar、res-mini.zip、preload.json
  public/puzzles/             … サンプル問題 JSON と index.json
  e2e/                        … Playwright のテスト
prototype/forge-adapter/      … Java 側（WebApi を v1 に拡張する。場所は Phase 1 の間は移さない）
tools/
  build-engine.sh             … jar → ProGuard → res バンドル → app/public/engine/ へ配置
  pzl2json/                   … .pzl → 問題 JSON の変換（Java。forge-adapter のモジュールとして持つ）
```

- `prototype/web` の検証ページは計測用として残す。製品のコードは `app/` に新しく書く。
- Worker は **classic Worker** にする（CheerpJ は `importScripts` で読み込むため、Vite のモジュール Worker は使えない）。`public/` に置いて Vite の変換対象から外す。
- 静的配信で Range リクエストが必要（CheerpJ が jar を部分取得する）。Vite の dev サーバーと `vite preview` で Range が効くかを M3 で確認し、効かなければ `prototype/web/serve.mjs` を流用する。

## 2. 主要な設計判断

| # | 判断 | 推奨 | 理由 |
|---|---|---|---|
| D1 | クリア判定をどこで行うか | **TS の Puzzle Core に移す**。Java は構造化したイベント（ターン開始・フェイズ・終局）を返すだけにする。Java 側の現行の判定は JVM テストの照合用に残す | 要件 2 章の責務分担（Puzzle Core がクリア判定）。将来の条件（生存・除去・制限）を TS だけで増やせる |
| D2 | 選択肢の表し方 | ラベルだけでなく、**参照（`instanceId` / `player` / `abilityIndex` / `stackIndex`）を持つ構造**にする | 盤面のカードをタップして対象や唱える呪文を選ぶ UI に必要。いまの `"c123"` / `"a0"` は Forge の内部 ID に依存している |
| D3 | 盤面の情報量 | `GameView` に P/T、タイプ、マナコスト、ルール文、付けられているもの、マナプール、スタックの対象を追加する。差分ではなく毎回全体を返す | 状態取得は 1.4〜2.1 ms なので全体で十分（A4）。差分は不要 |
| D4 | イベントの通知 | **ステップごとにまとめて返す方式のまま**（A3 の逐次通知は Phase 1 では見送り） | 演出はまとめて受け取ったイベント列を順に再生すれば足りる |
| D5 | 待ち方 | **現行のブロック方式のまま**（A2 のリプレイ方式は見送り） | Worker 上で問題なく動いている |
| D6 | サンプル問題の res | 同梱する全サンプル問題のカードを 1 つの res バンドルにまとめる | 問題ごとにバンドルを切り替えると、切り替えのたびに初期化し直しになる |
| D7 | UI フレームワーク | Preact + Signals（または素の TS） | バンドルを小さく保つ。エンジンが重いので、UI 側は軽くする |
| D8 | カード表示 | テキストのカード（名前・コスト・タイプ・P/T・ルール文） | 画像の利用条件（V7）が未確定 |

## 3. マイルストーン

### M0. 環境とブランチの準備（0.5 日）

- この Mac には JDK・Maven・Node がない（Phase 0 は Windows で実施）。Temurin 21、Maven 3.9、Node 24 を入れる。
- `git submodule update --init --depth 1` で Forge 2.0.15 を取得し、forge-game をビルドする。ProGuard 7.10.0 と JDK クラスの書き出し（README の手順）を macOS 向けに書き直す。
- `prototype/README.md` の手順を、OS に依存しない形（`JAVA_HOME` を環境変数で渡す）に直す。
- ブランチ: `phase0/v0-v1` を main に入れてから、Phase 1 のブランチを切る。

### M1. Adapter API v1（Java）（3〜4 日）

1. `GameView` の拡張（D3）。カードごとに `instanceId`、オーナー / コントローラー、P/T（現在値と基本値）、タイプ、マナコスト、ルール文、カウンター、付けられているもの、攻撃中 / ブロック中を返す。プレイヤーごとにマナプール、手札の枚数、ライブラリーの枚数を返す。
2. 選択肢の構造化（D2）。`Option { id, label, ref?: { kind: "card"|"player"|"ability"|"stack", ... } }`。PRIORITY の選択肢は「どのカードの、どの能力か」を持たせる。
3. イベントの構造化（D1）。いまの文字列を `{ type: "turnBegan"|"phase"|"cast"|"resolved"|"life"|"damage"|"zoneChange"|"gameOver", ... }` にする。
4. 選択要求の種類を増やす。いまは既定の答え（fallbackLog）を返しているもののうち、サンプル問題で必要になるものから対応する。候補: モードの選択（`chooseModes`）、X の値（`announceRequirements`）、効果でカードを選ぶ（`chooseCardsForEffect` / `chooseSingleEntityForEffect`）、同時誘発の順序（`orderSimultaneousSa`）、戦闘ダメージの割り振り（`assignCombatDamage`）。
5. `WebApi` を v1 にする: `init / load / submit / reset / state` に加え、`version()`（Forge と API のバージョン）を返す。エラーは `{ error: { code, message } }` の形に揃える。
6. JUnit: 既存の 11 件を新しい形式で通す。追加した選択要求ごとにシナリオを足す。
7. `design/adapter-api.md` に TS の型定義と意味を書く。

### M2. サンプル問題と res のビルド（2 日）

1. `.pzl` → 問題 JSON の変換ツール。Forge の `res/puzzle/*.pzl` のうち、ゴールが「このターン中に勝利」で、未対応の要素（スタックに積まれた状態から始まる、装備・オーラが付いている、など）を含まないものを選ぶ。
2. 変換した問題を JVM 上で「読み込み → 全選択肢を探索せずに、用意した解答手順で解ける」ことを確認する。解答手順は問題 JSON とは別のファイル（`*.solution.json`）に置き、E2E テストでも使う。
3. 自作のシナリオ S1〜S8 と合わせて 10〜20 問を選ぶ。選ぶ基準: 呪文・起動型能力・戦闘・誘発・マナの手動支払いが一通り含まれる。
4. `tools/build-engine.sh`: jar のビルド → ProGuard → `ResBundler`（サンプル問題すべてのカード）→ `app/public/engine/` への配置を 1 コマンドにする。`preload.json` も更新する。
5. 問題データの検証: 読み込み後に fallbackLog が空でない問題はビルドを失敗させる（要件 4.3「作成時の検証で検出」）。

### M3. Web アプリの土台とエンジンのクライアント（1〜2 日）

1. `app/` を Vite + TS で作る。ESLint / Prettier / Vitest を入れる。
2. `engine/client.ts`: Worker への RPC（ID 付きのリクエストとレスポンス）、型付きの `ForgeEngine` インターフェース、各呼び出しのタイムアウト（初期化 60 秒、操作 30 秒）、初期化の失敗時に 1 回だけ再試行する処理。CheerpJ の初期化が返らないことがまれにあった（cheerpj.md「その他」）ため。
3. 準備状況の通知: `booting → initializing → ready`。UI は問題データから盤面を先に描画し、`ready` になってから操作を受け付ける（A1 の所見）。
4. 静的配信で Range リクエストが効くかを確認する。

### M4. Puzzle Core（1 日）

1. `schema.ts`: 問題データの型と検証。schemaVersion とエンジンのバージョンの照合（要件 6 章「互換性がない古い問題にはエラー」）。
2. `judge.ts`: イベント列から結果を出す純粋関数。勝利 → クリア、期限（次のターンの開始）を過ぎた → 失敗、敗北 → 失敗、異常終了 → クリアにしない。Vitest で S1〜S3 のイベント列を使って確認する。
3. `session.ts`: 状態遷移（読み込み中 → 操作中 → 終了）と、リセット。
4. 問題一覧（`public/puzzles/index.json`）と、クリア済みかどうかの記録（localStorage）。

### M5. UI（5〜7 日）

要件 8 章のレイアウトに従う。

| 画面の要素 | PC | スマホ |
|---|---|---|
| 相手の戦場 / 自分の戦場 / 手札 | 上 / 中央 / 下 | 縦に並べる。手札は横スクロール |
| カード詳細 | 右側のパネル | 長押しで表示 |
| 目標・ログ | サイドパネル | 折りたたみ |
| 選択要求 | 盤面のカードを強調し、タップで選ぶ。下部にバー（パス・決定・取りやめ） | 同じ。下部のバーを大きくする |

選択要求の種類ごとの UI:

| 種類 | UI |
|---|---|
| PRIORITY | 使えるカードを強調する。カードをタップ → そのカードの能力の一覧（1 つなら即決）。「パス」ボタンは常に表示し、次に止まる場所（例:「戦闘へ」「ターン終了」）を書く |
| TARGETS | 対象にできるカード・プレイヤーを強調し、タップで選ぶ |
| ATTACKERS | 攻撃できるクリーチャーをタップで切り替え、「攻撃する」で決定 |
| PAY_MANA | 使えるマナ源を強調し、1 つずつタップする。「自動で支払う」「取りやめ」 |
| CHOOSE_CARDS / 効果の選択 | 候補のカードを並べたシートを出す |
| CONFIRM / モード / X | ダイアログ |

- 結果の表示: クリア / 失敗（理由つき）と「もう一度」（リセット）。
- エラーの表示: エンジンの異常は内容を表示し、「リセット」「再読み込み」を出す。
- イベントの再生: 1 ステップ分のイベント（ダメージ・ライフの変化・墓地へ）を短い演出で順に見せる。演出の間は入力を受け付けない。

### M6. テストと計測（2 日）

1. Playwright で、サンプル問題をすべて解答手順どおりに解く E2E テスト（Chrome、WebKit）。モバイルの画面サイズでも同じテストを回す。
2. 失敗系: 不正な問題データ、期限切れ、自分に撃って負ける、操作中のリセット。
3. 計測: 準備完了まで（初回 / 2 回目）、読み込み、1 操作。PC と、iOS Safari / Android Chrome の実機（LAN 内の開発サーバーで開く）。Phase 0 の C7 をここで兼ねる。
4. 結果を `prototype/results/phase1.md` に残す。

### スケジュールの目安

| 週 | 内容 |
|---|---|
| 1 週目 | M0、M1、M2 の変換ツール |
| 2 週目 | M2 の残り、M3、M4、M5 の着手（PC のレイアウト） |
| 3 週目 | M5（スマホのレイアウト、選択要求の UI）、M6 |

M1・M2（Java）と M3・M4（TS）は、M1 の型定義（`adapter-api.md` の草案）さえ先に決めれば並行して進められる。

## 4. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| スマホ実機で初期化が遅い（CPU 4 倍遅い条件で 12〜16 秒） | 完了条件 3 を満たせない | M3 の時点で実機の計測を一度行う。遅ければ、準備中も盤面を見て考えられる UI にして体感を補う |
| `.pzl` の問題に未対応の選択・コストが多い | サンプル問題が集まらない | 対応しやすい問題から選ぶ。足りなければ自作の問題で補う |
| CheerpJ のライセンス（P3）が未解決 | 公開できない | Phase 1 は社内での確認にとどめる。問い合わせは並行して進める |
| Vite の dev サーバーで Range が効かない | 開発中に jar を読めない | `serve.mjs` を dev 用のプロキシとして使う |
| Forge のカード ID と問題のインスタンス ID の対応がずれる（並び順で対応付けている） | 盤面の表示が崩れる | 対応付けに失敗したら読み込みエラーにする（実装済み）。M2 の全問題で確認する |

## 5. 決めておくこと

- `phase0/v0-v1` を main に入れるか（入れてから Phase 1 のブランチを切る）
- UI フレームワーク（D7）: Preact か、素の TS か
- サンプル問題の数と、`.pzl` から取るか自作するかの比率
- 実機の確認に使う端末（iOS / Android の機種）
