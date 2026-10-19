# CheerpJ 4.3 採用に向けた検証プラン

前提: [verification-plan.md](verification-plan.md) の V2 で、CheerpJ 上で Forge を無改修のまま動かせることを確認した（[results/v2.md](../prototype/results/v2.md)）。
本書では、CheerpJ を使う 3 つの方式を比べ、採用する構成を決めるための検証手順をまとめる。

## 0. 3 方式の位置づけ

| 方式 | 何を決めるか | V2 時点の状況 |
|---|---|---|
| A. Forge を Java ライブラリとして使う | **呼び出し方**: TS から Java のメソッドを直接呼ぶ（`cheerpjRunLibrary`） | ✅ 最小形は動作済み。`WebApi` を JSON 文字列で呼び、S1〜S8 が通った |
| B. Forge デスクトップ版をそのまま動かす | **比較・参照用**: Swing の UI をブラウザに描画する（`cheerpjRunJar`） | 未着手 |
| C. ルール処理だけを jar にまとめる | **何を同梱するか**: forge-core / forge-game と Adapter だけにする | △ forge-ai・Jackson 込みの 16 MB jar で動作済み。まだ絞り込んでいない |

A と C は対立する案ではない。**A（呼び出し方）＋ C（同梱物）を組み合わせたものが製品の本命構成**で、B はそれを評価するための参照実装と位置づける。
V2 の構成はすでに「A＋C の初版」にあたる。そこで本プランでは、**C で同梱物を減らし、A で製品に必要な呼び出しの性質を固め、B は時間を区切って試す**順に進める。

## 1. 共通の準備（P）

| ID | 内容 | 理由 |
|---|---|---|
| P1 | **計測用の環境を用意する**: 通常の Chrome（PC）、iOS Safari、Android Chrome。localhost を LAN 内の端末に公開するか、Cloudflare Pages のプレビューを使う | アプリ内ブラウザでは、2 回目以降の読み込みが CheerpJ 内部の iframe の処理で止まる（この環境に固有。通常の Chrome では問題なし）。PC の計測は `web/cdp-run.mjs`（ヘッドレス Chrome）か通常の Chrome で行う |
| P2 | **計測の手順を固定する**: タブを前面に出した状態で、初回（キャッシュなし）と 2 回目（キャッシュあり）を各 3 回測る | V2 では、バックグラウンドのタブで boot が 111 秒、前面では 2.3 秒と大きく違った |
| P3 | **ライセンスを確認する**: 本プロジェクトを GPL の FOSS として公開する場合に Community Edition の範囲に入るか。入らない場合の費用（Core はアプリ単位、Small Business は開発者 1 人あたり月 £100） | 方式に関係なく採用可否を左右する。早めに Leaning Technologies に問い合わせる |
| P4 | **計測項目を共通化する**: `harness.js` の `__metrics` に、ダウンロード量（jar / ランタイム / res）、boot、res 展開、Forge 初期化、load、submit、reset、ヒープ使用量を記録し、`results/` に CSV で残す | 方式間・端末間で比べるため |

## 2. 方式C: ルール処理だけの jar（同梱物の最小化）

**目的**: スマホでも実用になるダウンロード量・起動時間・メモリにする。
**V2 の基準値**: jar 16 MB、res 2.2 MB、準備完了まで初回 10.8 秒・2 回目以降 6.1 秒（PC、ヘッドレス Chrome）。

### 現在の依存関係と削減候補

| 依存 | 大きさ（圧縮後） | 使われている場所 | 方針 |
|---|---|---|---|
| forge-core / forge-game | 2.4 MB | ルール本体 | 必須 |
| forge-ai | 1.0 MB | マナとコストの自動支払い（`ComputerUtilMana` / `AiCostDecision`）、未対応の選択の代行 | **C3 で切り離しを試す**（マナ支払いの自前実装が必要） |
| commons-math3 | 2.5 MB の一部 | forge-ai のシミュレーションだけ | forge-ai を外せば不要。外さない場合も ProGuard で削る |
| Guava | 2.4 MB | Forge 全体（EventBus など） | 必須。ProGuard で未使用部分を削る |
| Jackson | 1.9 MB | Adapter（`WebApi` / `PuzzleDefinition`） | **外す**。JSON は手書きの小さなシリアライザにするか、TS 側で解釈して Java にはプリミティブで渡す |
| jgrapht（+ jheaps, apfloat） | 0.9 MB | `GameAction` | 必須。ProGuard で削る |
| sentry | 0.2 MB | forge-game の `AbilityFactory` など（ブレッドクラム） | スタブ jar に差し替える |
| tinylog / rssreader | 小 | ログ、ニュース取得 | スタブに差し替えるか、除外する |

### 検証項目

| ID | 内容 | 手順 | 合格基準 |
|---|---|---|---|
| C1 | **依存関係の実測** | `mvn dependency:tree` と `jdeps --print-module-deps`、さらに実行時に読み込まれたクラスの一覧（JVM の `-Xlog:class+load` と CheerpJ の `cjGetRuntimeResources()`）を突き合わせる | S1〜S8 で実際に使うクラスとライブラリの一覧ができる |
| C2 | **Jackson を外し、ProGuard で縮める** | Adapter の JSON 処理を置き換えたうえで、ProGuard の shrink（難読化なし）をかける。リフレクションで呼ばれるクラス（EventBus の購読者、`TriggerType` / `ReplacementType` のコンストラクタ）は keep に指定する | JVM のテスト 9 件と CheerpJ 上の S1〜S8 が通る。jar が **8 MB 以下** |
| C3 | **forge-ai を切り離せるか** | マナの支払い（土地のマナ能力を順に起動し、マナプールから払う）とコストの支払いを Adapter 側に実装し、forge-ai の依存を外す。forge-gui にある人間用の実装（`HumanPlay` / `HumanCostDecision`）から、GUI に依存しない部分を移植できるかも調べる | S1・S4（マナ支払いあり）が forge-ai なしで通る。移植・実装の規模（行数）を見積もれる |
| C4 | **res の絞り込み** | editions を、問題で使うカードの収録セットだけに絞る（5.5 MB → ?）。tokenscripts も、使うトークンだけにする | res が **1 MB 以下**。Forge の初期化時間が短くなる |
| C5 | **res の展開をやめる** | /files（IndexedDB）への展開をやめ、(a) `/app/` から直接読む（ディレクトリ一覧が使えない箇所は、索引ファイルを用意して Adapter から渡す）か、(b) `/str/`（`cheerpOSAddStringFile`）に JS から書き込む方式を比べる | 展開の 4.5 秒がなくなる |
| C6 | **起動の最適化** | `cjGetRuntimeResources()` でプリロード一覧を作り、`cheerpjInit({preloadResources})` に渡す | 初回のロード時間の短縮幅を計測できる |
| C7 | **スマホ実機で計測**（P1 の環境） | iOS Safari / Android Chrome で S1・S2・S4 を実行する | 準備完了まで **初回 15 秒以内・2 回目 5 秒以内**（目安）。タブが落ちない |

## 3. 方式A: TS から Java を直接呼ぶ（呼び出しの性質を固める）

**目的**: 製品の UI から安全に呼べる API の形を決める（V3 の Adapter API を確定する）。

| ID | 内容 | 手順 | 合格基準 |
|---|---|---|---|
| A1 | **Web Worker 上で動かす** | Worker の中で `importScripts(loader.js)` を実行し、`cheerpjInit` / `cheerpjRunLibrary` を呼ぶ。メインスレッドとは postMessage でやり取りする（CheerpJ 3 以降は `CheerpJWorker` が廃止され、この方式になった。DOM が要る処理は Worker では使えない） | S1〜S8 が Worker 上で通る。Java が処理している間も UI がかたまらない（Long Task が 50 ms を超えない） |
| A2 | **待ち方の比較** | 現行方式（Java 側でゲームスレッドをブロックし、呼び出し側は回答を待つ）と、リプレイ方式（回答ログを使って毎回最初から再実行する）を CheerpJ 上で比べる | 現行方式で問題がなければそのまま採用する。リプレイ方式は、Forge の乱数シードを固定すれば決定的に再現できるかを JVM で確認する |
| A3 | **Java からのイベント通知** | 現在はステップごとにイベントをまとめて返している。`cheerpjInit({natives})` を使って Java から JS へ逐次通知する方式も試す（例: 演出のためにダメージを 1 件ずつ送る） | どちらを採るか決める。逐次通知の遅延を計測できる |
| A4 | **境界をまたぐデータの形** | JSON 文字列とプリミティブ配列の 2 方式で、`getState` 1 回あたりの時間を比べる。record は使わない（CheerpJ 17 プレビューでは `JVM_IsRecord` が未実装） | 1 回 **10 ms 以下** |
| A5 | **異常時の扱い** | Java の例外、ゲームスレッドの停止（タイムアウト）、問題データの不正、を起こしたときの JS 側の挙動を確認する | どの場合も UI にエラーを表示でき、reset か再読み込みで復帰できる |
| A6 | **長時間の利用とメモリ** | 同じパズルを 50 回 reset し、別のパズルへの切り替えを 20 回繰り返して、ヒープとタブのメモリを測る | メモリが増え続けない（スレッドやゲームが解放されている） |
| A7 | **API を確定する** | A1〜A6 の結果をもとに、TS の型定義（`ForgeEngine` インターフェース）と Java 側の `WebApi` を確定する | V3 の成果物として、`design/` に API 仕様を残す |

## 4. 方式B: デスクトップ版をそのまま動かす（時間を区切った参照 PoC）

**目的**: (1) Forge 全体が CheerpJ で動くか確認する（A＋C で問題が出たときの切り分けに使う）、(2) デスクトップ版のパズルモードを、正解を確かめる「参照実装」としてブラウザで使えるか見る。
**製品の UI としては採用しない**（スマホでの操作性と、独自のパズルエディタの要件を満たさないため）。**作業は 1 日で打ち切る。**

| ID | 内容 | 手順 | 合格基準 |
|---|---|---|---|
| B1 | **デスクトップ版のビルド** | `mvn -pl forge-gui-desktop -am package` で、依存込みの jar を作る（mainClass は `forge.view.Main`）。依存には miglayout、freemarker、jlayer、imageio-jpeg などが増える | jar ができ、サイズを記録する |
| B2 | **res の用意** | res の全体は **430 MB** あってそのままでは配れない。起動に必要な最小構成（ミニの cardsfolder、skins、languages の en-US、defaults）を、起動時のエラーを見ながら絞り込む。設定などの書き込み先（ユーザーディレクトリ）を /files に向ける | 起動に必要な res の一覧とサイズが分かる |
| B3 | **CheerpJ で起動** | `cheerpjCreateDisplay(-1, -1, document.body)` を呼んでから `cheerpjRunJar("/app/forge-desktop.jar")` を実行する | メイン画面が表示される |
| B4 | **パズルモードを解く** | Puzzle Mode から、S1 相当の `.pzl` を読み込んで解く | クリアの判定まで動く。操作のもたつき（体感）と起動時間を記録する |
| B5 | **スマホで表示** | B3 を iOS Safari / Android Chrome で開く | 表示と操作ができるか（できなくても可。記録のみ） |

B1〜B3 のどこかで 1 日を超えそうになったら、その時点で止め、詰まった箇所を記録して終える。

## 5. 進め方と判断ゲート

| 順番 | 作業 | 目安 | 判断 |
|---|---|---|---|
| 1 | P1〜P4（環境・ライセンス・計測の準備） | 1 日（P3 の回答待ちは並行） | — |
| 2 | C1 → C2 → C4 → C5 → C6 | 3〜4 日 | **GC1**: jar 8 MB 以下・res 1 MB 以下・PC で準備完了 5 秒以内 |
| 3 | A1 → A4 → A5 → A6 | 2〜3 日 | **GA1**: Worker 上で UI がかたまらない |
| 4 | C7（スマホ実機） | 1 日 | **GC2**: スマホで実用的な起動時間とメモリか |
| 5 | C3（forge-ai の切り離し） | 2〜3 日 | 規模が大きすぎる場合は、forge-ai を残す方向で確定する |
| 6 | B1〜B5（並行してよい） | 1 日で打ち切り | 参照実装として使えるか |
| 7 | A2・A3・A7 → API を確定 | 1〜2 日 | **G2 の最終判定**: CheerpJ（A＋C）を採用するか |

GC1・GC2 を満たせない場合や、P3 のライセンス条件が受け入れられない場合は、次の代替案を再検討する。
- 見送った GraalVM Web Image（スレッドがないため、A2 のリプレイ方式が前提になる）
- TeaVM（Forge の改修が必要）

## 6. 成果物

- `prototype/results/cheerpj-*.md` / `.csv`: 各項目の結果と計測値
- `prototype/forge-adapter`: Jackson をなくした `WebApi`、ProGuard 設定、（C3 を実施した場合）マナ支払いの実装
- `prototype/web/cheerpj-worker/`: Worker 版のハーネス（A1）
- `prototype/web/cheerpj-desktop/`: デスクトップ版の起動ページ（B）
- `design/adapter-api.md`: 確定した API（A7）
