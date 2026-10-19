# prototype — Phase 0 検証環境

手順は [../design/verification-plan.md](../design/verification-plan.md) を参照。

## セットアップ

| 項目 | 内容 |
|---|---|
| Forge | `prototype/forge`（git submodule、shallow）。タグ `forge-2.0.15`（commit `4ec5f1a2`）に固定 |
| JDK | 21 以上（Forge の要件は 17 以上）。この端末では Android Studio に同梱の JBR 21.0.10 を使っている |
| Maven | 3.9.16。`~/tools/apache-maven-3.9.16` に zip を展開しただけ（PATH は変更していない） |

```bash
git submodule update --init --depth 1
```

```bash
git -C prototype/forge config core.longpaths true
```

forge-game とその依存モジュールだけをビルドする（Git Bash から実行）:

```bash
cd prototype/forge && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B -pl forge-game -am install -DskipTests -Dcheckstyle.skip
```

forge-ai もビルドする場合（C3 以降、forge-adapter は forge-ai に依存していない。V1・V2 当時の構成を再現するときだけ必要）:

```bash
cd prototype/forge && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B -pl forge-ai -am install -DskipTests -Dcheckstyle.skip
```

## forge-adapter（V1）

GUI なしで Forge を外部から操作する Adapter と、検証シナリオのテスト。問題データは [puzzles/](puzzles/) にある。

```bash
cd prototype/forge-adapter && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B test
```

全件ロードで計測するときは `-Dlazy=false` を付ける。

## ブラウザ検証（V2）

1. 依存込み jar を作る（`forge-adapter/target/forge-adapter-all.jar`）:

```bash
cd prototype/forge-adapter && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B package -DskipTests
```

2. 問題で使うカードだけを入れた res バンドルを作る（`web/res-mini.zip`）:

```bash
cd prototype/forge-adapter && "/c/Program Files/Android/Android Studio/jbr/bin/java" -cp target/forge-adapter-all.jar mtgpuzzle.adapter.ResBundler ../forge/forge-gui/res ../puzzles ../web/res-mini.zip
```

2b. （任意）ProGuard で jar を縮める（`forge-adapter/target/forge-adapter-min-all.jar`）。ProGuard 7.10.0 を `~/tools/proguard/lib` に、JDK のクラスを `~/tools/jdk21-classes` に用意しておく（手順は [results/cheerpj.md](results/cheerpj.md)）:

```bash
prototype/forge-adapter/shrink.sh all
```

3. 静的サーバーを起動し（`prototype/` がルート、ポート 8123）、`http://localhost:8123/web/cheerpj/index.html` を開く。Worker 版は `web/cheerpj-worker/index.html`。クエリで `?jar=min-all`（縮めた jar）、`&preload=1`（プリロード）を指定できる:

```bash
node prototype/web/serve.mjs
```

ヘッドレス Chrome で読み込みを 3 回くり返して計測する（サーバー起動中に実行。プロファイルは一時ディレクトリを指定する）:

```bash
node prototype/web/cdp-run.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe" "$TEMP/cdp-prof" "http://localhost:8123/web/cheerpj/index.html" 3
```

アプリ内ブラウザでは、CheerpJ のページの 2 回目以降の読み込みが止まる（この環境に固有）。計測は上のヘッドレス Chrome か通常の Chrome で行う。

TeaVM の変換を試すとき（V2-B）:

```bash
cd prototype/wasm/teavm && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B package
```

## 検証結果

- V0: [results/v0.md](results/v0.md)
- V1: [results/v1.md](results/v1.md)
- V2: [results/v2.md](results/v2.md)
- CheerpJ 検証: [results/cheerpj.md](results/cheerpj.md)
