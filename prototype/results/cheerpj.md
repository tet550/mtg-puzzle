# CheerpJ 検証結果（2026-10-19）

検証プラン: [design/cheerpj-verification-plan.md](../../design/cheerpj-verification-plan.md)
計測環境: Windows 11 の開発用 PC。ヘッドレス Chrome を `web/cdp-run.mjs` で操作し、サーバーは localhost（`web/serve.mjs`）。CheerpJ 4.3（Java 17 プレビュー）。

## まとめ

| 指標 | V2（初版） | 今回 | 目標（プラン） |
|---|---|---|---|
| jar | 16 MB | **5.4 MB** | 8 MB 以下 ✅ |
| res バンドル | 2.2 MB / 1,622 ファイル | **178 KB / 90 ファイル** | 1 MB 以下 ✅ |
| 準備完了（初回、キャッシュなし） | 10.8 秒 | **7.7 秒**（3 回平均） | — |
| 準備完了（2 回目以降） | 6.1 秒 | **2.6 秒**（8 回） | 5 秒以内 ✅（GC1） |
| 1 操作（submit） | 約 40 ms | 80〜120 ms（Worker 経由・状態込み） | — |
| 状態取得 1 回 | — | **1.4〜2.1 ms** | 10 ms 以下 ✅ |
| メインスレッドの Long Task | — | Worker 版で **0 件** | 50 ms 超なし ✅（GA1） |

- **PC では GC1・GA1 とも達成した。**
- **残る最大の課題はスマホでの初期化時間。** CPU を 4 倍遅くした条件（スマホ相当の目安）では、準備完了まで 12〜16 秒かかった。実機での確認（C7）が必要。

## 方式C: 同梱物の最小化

### C1: 実行時に実際に使うクラス（JVM、シナリオテスト全件）

| ライブラリ | 読み込まれたクラス数 | 備考 |
|---|---|---|
| forge-game | 738 / 901 | ほぼ全部（効果の種類ごとにクラスを登録するため） |
| forge-core | 130 / 228 | |
| forge-ai | **23 / 262** | 使っているのはマナとコストの自動支払いだけ |
| Guava | 400 | |
| Jackson | 約 530 | Adapter の JSON 処理だけ → 削除 |
| sentry | 102 | 実行時に初期化されている（ブレッドクラム用） |
| tinylog | 52 | |
| commons-math3 / apfloat / jheaps | 0 | 一度も使われない |

### C2: Jackson の削除と ProGuard

- Jackson をやめて、小さな自作の JSON 処理（`Json.java`、リフレクションなし）に置き換えた。jar は 16 MB → 14 MB。
- ProGuard 7.10.0 で未使用のクラスを削った（難読化・最適化なし）。設定は `forge-adapter/proguard.pro`、実行は `forge-adapter/shrink.sh <mode>`。
  - 準備 1: ProGuard と依存 jar を `~/tools/proguard/lib` に置く（`com.guardsquare:proguard-base:7.10.0` を `mvn dependency:copy-dependencies` で取得）。
  - 準備 2: 使っている JBR には jmods がないので、`jimage extract --dir x --include "regex:/(java\.base|java\.logging|java\.management|java\.sql|java\.naming|java\.xml|java\.desktop|jdk\.unsupported)/.*\.class" <jbr>/lib/modules` で JDK のクラスを書き出し、モジュールごとに jar にして `~/tools/jdk21-classes` に置く（ProGuard のライブラリとして使う）。

| モード | 残す範囲 | jar | スモークテスト |
|---|---|---|---|
| all | forge.** はすべて残す | **5.42 MB** | ✅ 全件 OK |
| noai | forge.ai.** だけ到達可能な分に絞る | 5.41 MB | ✅ |
| game | forge.game.** と forge.card.** だけすべて残す | 5.11 MB | ✅ |

- 安全側の **all を採用**した。noai はほとんど縮まない（forge.ai は静的に参照されている範囲が広い）。game は 0.3 MB 小さいが、スモークテストで使っていないカードの効果で壊れる危険がある。
- 縮小後の内訳（圧縮後のクラス）: forge.game 2.2 MB、forge.ai 1.0 MB、Guava 0.6 MB、その他 1 MB 未満。ライブラリはほぼ消え、**残りの大半は Forge 本体**。
- ProGuard が tinylog の実装クラス（ServiceLoader 経由でしか参照されない）を削ったため、ログは出なくなった（`LOGGER WARN` が出る）。ブラウザでは不要なので問題ない。
- CheerpJ は jar を Range リクエストで必要な部分だけ読むので、jar を縮めても準備完了の時間はほとんど変わらなかった。効くのは転送量（初回 5.2 MB）。

### C4: res の絞り込み

- `ResBundler` を拡張し、editions はカードごとに収録エディションを 1 つだけ（Core / Expansion を優先し、その中で最も古いもの）、tokenscripts はカードのスクリプトにある `TokenScript$` の名前だけを同梱するようにした（`--full-editions` / `--all-tokens` で全部入れることもできる）。
- 現在のシナリオのカードでは、エディション 3 つ、トークン 0 個になった。
- **Forge の初期化のうち StaticData の構築が 3.6〜4.3 秒から 0.9〜1.3 秒に縮んだ。**
- 落とし穴が 2 つあった。
  - 中身が空のディレクトリは zip に入らないため、Forge が「tokenscripts がない」と例外を出した。初期化の前にディレクトリを作るようにした。
  - バンドルを差し替えても古い展開物が /files に残っていた。そこで、バンドルが変わったら展開先を空にしてから展開するようにした。
- 一時ディレクトリの作成（`createTempDirectory`）が CheerpJ では約 1 秒かかったので、res の下にディレクトリを作る方式に変えた。

### C5: res の展開

- ファイルが 90 個に減ったので、展開は初回 0.4 秒、2 回目以降は 0.01 秒（キャッシュ）になった。**展開をやめる対応は不要と判断した。**

### C6: プリロード（`preloadResources`）

- `cjGetRuntimeResources()` で取った一覧を `web/cheerpj/preload.json` に保存し、`?preload=1` で使えるようにした。一覧に入っているのは CheerpJ ランタイムの 9 ファイルで、自分たちの jar は含まれない。
- 初回（毎回まっさらなプロファイル）で 3 回ずつ比べた結果:

| | 準備完了 | うち boot |
|---|---|---|
| プリロードなし | 9.9 / 11.0 / 9.4 秒（平均 10.1） | 7.3〜8.7 秒 |
| プリロードあり | 7.6 / 7.4 / 8.3 秒（平均 7.7） | 5.5〜6.4 秒 |

- 2 回目以降（同じプロファイルで 8 回）: 準備完了 **2.5〜4.1 秒**（初回を除くと 2.5〜2.7 秒）。8 回とも S1 をクリアし、止まることはなかった。
- 計測用サーバーは `Cache-Control: no-cache` で毎回 jar を送り直している（5.2 MB）。本番の静的ホスティングでキャッシュが効けば、2 回目以降の転送はほぼなくなる。

### C7（代替）: CPU を遅くした条件（CDP の `Emulation.setCPUThrottlingRate`）

実機の代わりにはならない目安。**CDP の速度制限は Worker には効かない**ので、測ったのはメインスレッド版だけ。

| 速度 | 準備完了（初回 / 2 回目） | Forge 初期化 | パズル読み込み | 1 操作 |
|---|---|---|---|---|
| 1 倍 | 7.4 / 3.6 秒 | 1.4〜1.7 秒 | 1.4 秒 | 約 0.1 秒 |
| 4 倍遅い | 15.7〜17.5 / 12.0〜12.2 秒 | 6.9〜7.4 秒 | 7.7〜7.9 秒 | 約 0.55 秒 |
| 6 倍遅い | 26.2 / 18.7 秒 | 10.7〜10.9 秒 | — | — |

4 倍遅い条件での初期化の内訳: StaticData 4.7 秒、Localizer 1.4 秒、cardReaders 0.4 秒、その他 0.4 秒。CheerpJ 上でのクラス読み込みと実行のコストが大半で、res をこれ以上減らしても大きくは縮まない見込み。

## 方式A: TS から Java を呼ぶ

### A1: Web Worker 上で動かす

- `web/cheerpj-worker/`。Worker の中で `importScripts(loader.js)` → `cheerpjInit` → `cheerpjRunLibrary` を行い、メインスレッドとは postMessage（JSON 文字列）でやり取りする。**S1 をクリアでき、メインスレッド版と同じに動いた。**
- メインスレッドの Long Task:

| | 1 倍 | 4 倍遅い |
|---|---|---|
| メインスレッド版 | 2 件、最大 78 ms | **32〜40 件、最大 345 ms、合計 2.4〜3.5 秒** |
| Worker 版 | **0 件** | 0 件（ただし速度制限は Worker に効かないので参考値） |

- **製品は Worker 版で作る。** 遅い端末では、メインスレッド版だと UI が数百 ms 単位でかたまる。
- Forge の初期化は数秒かかるので、UI 側は「問題データから盤面を先に描画し、エンジンの準備ができたら操作を受け付ける」形にするとよい。

### A4: 境界をまたぐデータ

- 状態取得（`state()`、JSON 約 1.2 KB）は 1 回 **1.4 ms（Worker）〜2.1 ms（メインスレッド）**。JSON 文字列で受け渡す方式で十分速い。
- record は使っていない（`WebApi` で Map に変換している）。

### A5: 異常時の扱い（Worker 版で確認）

| ケース | 結果 |
|---|---|
| 存在しないカード | `{"error": "PuzzleValidationException: 存在しないカード: ..."}` |
| 壊れた JSON | `{"error": "IllegalArgumentException: JSON の解析に失敗しました（位置 19）..."}` |
| 未対応の schemaVersion | `{"error": "PuzzleValidationException: 未対応の schemaVersion: 99"}` |
| 選択数が範囲外 | エラーを返し、選択待ちの状態は残る |
| **存在しない選択肢 ID** | **不具合を発見**: ゲームスレッドで例外が起きてゲームが止まっていた。→ `submit` の入口で ID を検証するよう修正し、回帰テストを追加した（JVM のテストは 10 件すべて成功）。修正後はエラーを返し、そのまま続行できる |
| 終局後の submit | `{"error": "IllegalStateException: 回答待ちの選択がありません"}` |
| 終局後の reset | 初期盤面に戻り、操作を再開できる |

### A6: 長時間の利用

- reset を 50 回くり返しても、Java のスレッド数は 4 のまま増えなかった。ゲームスレッドはリークしていない。
- JS ヒープ（メインスレッド版）: 開始時 206 MB → reset 50 回ごとに 209 / 205 / 221 MB → さらにパズルの読み込みを 20 回行い、GC 後は 103 MB。増え続ける傾向はない。
- CheerpJ では Java の `Runtime.totalMemory()` が常に 1024 MB を返すので、Java 側からはメモリを測れない。

## その他

- ヘッドレス Chrome でのおよそ 30 回の読み込みのうち、1 回だけ計測値が返らずに終わった（再現せず。直後の 8 回の連続読み込みはすべて正常）。製品では、初期化のタイムアウトと再試行を用意しておく。
- アプリ内ブラウザでは、2 回目以降の読み込みが止まる現象がある（[v2.md](v2.md) 参照）。計測には使わない。

## 未実施の項目

| ID | 内容 | 理由・次の一手 |
|---|---|---|
| P1 | Cloudflare Pages での配信（Range リクエスト・キャッシュ） | 外部への公開を伴うため、アカウントとデプロイ先の判断が必要 |
| P3 | ライセンスの確認 | Leaning Technologies への問い合わせが必要 |
| C7 | スマホ実機（iOS Safari / Android Chrome） | 端末が必要。Worker 版の実際の速さもここで確かめる |
| C3 | forge-ai の切り離し（マナ・コスト支払いの自前実装） | 実行時に使う forge-ai のクラスは 23 個だけだが、jar の 1 MB を占める。数日規模の作業 |
| B | デスクトップ版の起動（1 日で打ち切り） | 未着手 |
| A2 / A3 / A7 | 待ち方の比較、Java からの逐次通知、API の確定 | 未着手。現行の待ち方（ゲームスレッドをブロックする方式）は Worker 上でも問題なく動いている |
