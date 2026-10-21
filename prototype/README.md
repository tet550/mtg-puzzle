# prototype — Phase 0 検証環境

手順は [../design/verification-plan.md](../design/verification-plan.md) を参照。

## セットアップ

| 項目 | 内容 |
|---|---|
| Forge | `prototype/forge`（git submodule、shallow）。タグ `forge-2.0.15`（commit `4ec5f1a2`）に固定 |
| JDK | 21 以上（Forge の要件は 17 以上）。`JAVA_HOME` で指定する |
| Maven | 3.9 以上 |
| Node.js | 24（検証ページのサーバーと計測スクリプト） |
| Python | 3（forge-adapter のビルドで、Forge のクラスの上書きを生成する。[../design/forge-overlay.md](../design/forge-overlay.md)） |

導入の例:
- macOS: `brew install openjdk@21 maven node@24`。`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`
- Windows: Android Studio に同梱の JBR 21 と、zip を展開した Maven（Phase 0 はこの構成）。`JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"`（Git Bash）

以下のコマンドは、`JAVA_HOME` を設定し、`$JAVA_HOME/bin` と `mvn` を PATH に入れた状態で、リポジトリのルートから実行する。

```bash
git submodule update --init --depth 1
```

Windows では長いパスを許可しておく:

```bash
git -C prototype/forge config core.longpaths true
```

forge-game とその依存モジュールだけをビルドする:

```bash
mvn -B -f prototype/forge/pom.xml -pl forge-game -am install -DskipTests -Dcheckstyle.skip
```

forge-ai もビルドする場合（C3 以降、forge-adapter は forge-ai に依存していない。V1・V2 当時の構成を再現するときだけ必要）:

```bash
mvn -B -f prototype/forge/pom.xml -pl forge-ai -am install -DskipTests -Dcheckstyle.skip
```

## forge-adapter（V1）

GUI なしで Forge を外部から操作する Adapter と、検証シナリオのテスト。問題データは [puzzles/](puzzles/) にある。

ビルドのときに、Forge の `Card` を CheerpJ で止まらない形に書き換えたものを生成し、forge-game の `Card` を上書きする。理由と、Forge を更新するときの手順は [../design/forge-overlay.md](../design/forge-overlay.md)。

```bash
mvn -B -f prototype/forge-adapter/pom.xml test
```

全件ロードで計測するときは `-Dlazy=false` を付ける。

## ブラウザ検証（V2）

1. 依存込み jar を作る（`forge-adapter/target/forge-adapter-all.jar`）:

```bash
mvn -B -f prototype/forge-adapter/pom.xml package -DskipTests
```

2. 問題で使うカードだけを入れた res バンドルを作る（`web/res-mini.zip`）:

```bash
"$JAVA_HOME/bin/java" -cp prototype/forge-adapter/target/forge-adapter-all.jar mtgpuzzle.adapter.ResBundler prototype/forge/forge-gui/res prototype/puzzles prototype/web/res-mini.zip
```

2b. （任意）ProGuard で jar を縮める（`forge-adapter/target/forge-adapter-min-all.jar`）。ProGuard 7.10.0 は初回に Maven で取ってくる。JDK のクラスは `$JAVA_HOME/jmods` を使い、jmods の無い JDK（Android Studio の JBR など）では `~/tools/jdk21-classes` を使う（手順は [results/cheerpj.md](results/cheerpj.md)）:

```bash
prototype/forge-adapter/shrink.sh all
```

3. 静的サーバーを起動し（`prototype/` がルート、ポート 8123）、`http://localhost:8123/web/cheerpj/index.html` を開く。Worker 版は `web/cheerpj-worker/index.html`。クエリで `?jar=min-all`（縮めた jar）、`&preload=1`（プリロード）を指定できる:

```bash
node prototype/web/serve.mjs
```

ヘッドレス Chrome で読み込みを 3 回くり返して計測する（サーバー起動中に実行。第 1 引数は Chrome の実行ファイル、第 2 引数はプロファイルの一時ディレクトリ）:

```bash
node prototype/web/cdp-run.mjs "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$TMPDIR/cdp-prof" "http://localhost:8123/web/cheerpj/index.html" 3
```

アプリ内ブラウザでは、CheerpJ のページの 2 回目以降の読み込みが止まる（この環境に固有）。計測は上のヘッドレス Chrome か通常の Chrome で行う。

TeaVM の変換を試すとき（V2-B）:

```bash
mvn -B -f prototype/wasm/teavm/pom.xml package
```

## 検証結果

- V0: [results/v0.md](results/v0.md)
- V1: [results/v1.md](results/v1.md)
- V2: [results/v2.md](results/v2.md)
- CheerpJ 検証: [results/cheerpj.md](results/cheerpj.md)
