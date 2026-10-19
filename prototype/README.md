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

forge-ai も含めてビルドする（forge-adapter が依存している）:

```bash
cd prototype/forge && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B -pl forge-ai -am install -DskipTests -Dcheckstyle.skip
```

## forge-adapter（V1）

GUI なしで Forge を外部から操作する Adapter と、検証シナリオのテスト。問題データは [puzzles/](puzzles/) にある。

```bash
cd prototype/forge-adapter && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ~/tools/apache-maven-3.9.16/bin/mvn -B test
```

全件ロードで計測するときは `-Dlazy=false` を付ける。

## 検証結果

- V0: [results/v0.md](results/v0.md)
- V1: [results/v1.md](results/v1.md)
