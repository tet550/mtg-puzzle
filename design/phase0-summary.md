# Phase 0 技術実証のまとめ（2026-10-19 時点）

要件: [requiremnts.txt](requiremnts.txt)
手順書: [verification-plan.md](verification-plan.md) / [cheerpj-verification-plan.md](cheerpj-verification-plan.md)

## 結論

**「Forge のルールエンジンをブラウザで動かし、独自の UI から操作する」構成は成立する。**
CheerpJ 4.3（Java 17）の上で、Forge 2.0.15 を**本体の改修なしに**動かした。そのうえで、盤面の復元、外部からの操作、勝敗と期限の判定、リセットまでを確認した。

| 要件の判断点 | 結果 |
|---|---|
| GameState で任意の盤面を復元できるか | ✅ JSON → GameState に変換して復元できる（タップ、召喚酔い、カウンター、フェイズ、ライフ） |
| Forge に外部から行動を入力できるか | ✅ 優先権・対象・攻撃・任意の誘発・マナの支払い・コストに使うカードを、「選択要求 → 回答」の形で入力できる |
| ブラウザ（WASM）で動くか | ✅ CheerpJ で動作する。TeaVM は変換できず、Manabrew は Rust による移植なので再利用できない |
| バックエンドなしで成立するか | ✅ 静的ファイルの配信だけで動く（CheerpJ のランタイムは提供元の CDN から配信される） |

## 採用する構成（案）

```
ブラウザ
├─ UI（TypeScript）            … 盤面表示・選択要求への回答
└─ Web Worker
   └─ CheerpJ 4.3（Java 17）
      └─ forge-adapter-min.jar（4.3 MB）
         ├─ WebApi              … JS から呼ぶ入口（JSON 文字列でやり取り）
         ├─ ForgeSession        … 盤面の復元、選択要求、勝敗・期限の判定、リセット
         ├─ Adapter のコントローラー … 外部入力（p1）／自動でパスする（p2）。forge-ai には依存しない
         └─ forge-game / forge-core（無改修）
   res-mini.zip（148 KB）       … 問題で使うカードだけを入れたデータ
```

## 主な数値（PC、ヘッドレス Chrome）

| 項目 | 値 |
|---|---|
| jar（ProGuard 後、forge-ai なし） | 4.3 MB |
| res バンドル | 148 KB |
| 準備完了まで（初回） | 3.5〜8 秒（CDN までのネットワーク状況でばらつく） |
| 準備完了まで（2 回目以降） | 2.5〜3 秒 |
| パズルの読み込み | 約 1.3 秒（初回のゲーム生成） |
| 1 操作 | 80〜120 ms |
| リセット | 約 60 ms |
| メインスレッドの Long Task（Worker 版） | 0 件 |
| CPU 4 倍遅い条件（スマホ相当の目安、メインスレッド版） | 準備完了 12〜16 秒 |

## 分かった落とし穴（対応済み）

- forge-gui の初期化に頼らないと、型リスト（`TypeLists.txt`）が読まれない。すると基本土地がマナ能力を持たなくなり、しかもエラーにならない。→ Adapter で読み込むようにした
- Forge の「遅延ロード」は、索引を作るためにカードの全ファイル（34k）を読む。→ ビルド時に、問題で使うカードだけをバンドルする
- CheerpJ の Java 17 はプレビュー版で、record のリフレクションが動かない。→ JSON は自作の処理で組み立てる
- 存在しない選択肢 ID を受け取ると、ゲームスレッドが止まっていた。→ 入口で検証する
- アプリ内ブラウザ（Claude のブラウザペイン）では、CheerpJ の 2 回目以降の読み込みが止まる。→ 通常の Chrome では起きない。計測には使わない

## 未解決の課題（次にやること）

| 優先 | 課題 | 内容 |
|---|---|---|
| 高 | **CheerpJ のライセンス** | 無償版は個人・FOSS・技術評価が対象。会社として提供する場合の条件を Leaning Technologies に確認する |
| 高 | **スマホ実機での計測** | 初期化が CPU の速さに比例して伸びる（4 倍遅いと 12〜16 秒）。iOS Safari / Android Chrome の実機で、Worker 版を計測する |
| 中 | 静的ホスティングでの配信 | Cloudflare Pages での Range リクエスト・キャッシュ・ファイルサイズの上限を確認する |
| 中 | Adapter API の確定 | TS の型定義（V3）。マナの手動支払いの UX、イベントを逐次通知するかどうか |
| 中 | 未対応の選択・コスト | コスト 40 種のうち 13 種は未対応。モード選択・X の値・誘発の順序などは既定の答えを返している（fallbackLog で検出できる） |
| 低 | デスクトップ版の起動（方式B） | 参照実装として使えるか。1 日で打ち切る前提 |

## 成果物の場所

| 場所 | 内容 |
|---|---|
| `prototype/forge` | Forge 2.0.15（submodule、無改修） |
| `prototype/forge-adapter` | Adapter 本体・テスト・ProGuard 設定・res バンドラー |
| `prototype/puzzles` | 検証シナリオの問題データ（JSON） |
| `prototype/web` | 検証ページ（CheerpJ のメインスレッド版／Worker 版）、計測スクリプト、静的サーバー |
| `prototype/wasm/teavm` | TeaVM での変換の試み（変換できないことの記録） |
| `prototype/results` | 各段階の計測結果（v0 / v1 / v2 / cheerpj） |
