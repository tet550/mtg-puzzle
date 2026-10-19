#!/usr/bin/env bash
# エンジン一式を作り、app/public/engine/ に置く（Phase 1 M2）。
#   1. forge-adapter の依存込み jar を作る
#   2. ProGuard で縮め、スモークテストを通す
#   3. app/public/puzzles/ の問題で使うカードだけを res バンドルにまとめる
#   4. 解答手順（*.solution.json）がある問題を、縮めた jar で解き直して確かめる
#      （解けない・既定の答えを使った問題があれば失敗にする）
# 前提: JAVA_HOME が Java 17 以上、mvn が PATH にある。Forge の forge-game を mvn install 済み（prototype/README.md）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="$ROOT/prototype/forge-adapter"
RES="$ROOT/prototype/forge/forge-gui/res"
PUZZLES="$ROOT/app/public/puzzles"
OUT="$ROOT/app/public/engine"
JAVA="${JAVA_HOME:?JAVA_HOME を Java 17 以上に設定してください}/bin/java"

mvn -B -q -f "$ADAPTER/pom.xml" package -DskipTests
# スモークテストは prototype/puzzles の検証シナリオで行う（shrink.sh が ../web/res-mini.zip を使う）
"$JAVA" -cp "$ADAPTER/target/forge-adapter-all.jar" mtgpuzzle.adapter.ResBundler "$RES" "$ROOT/prototype/puzzles" "$ROOT/prototype/web/res-mini.zip" > /dev/null
"$ADAPTER/shrink.sh" all | tail -1 | grep -q "ALL OK" || { echo "スモークテストに失敗しました"; exit 1; }

mkdir -p "$OUT"
cp "$ADAPTER/target/forge-adapter-min-all.jar" "$OUT/forge-adapter.jar"
"$JAVA" -cp "$ADAPTER/target/forge-adapter-all.jar" mtgpuzzle.adapter.ResBundler "$RES" "$PUZZLES" "$OUT/res-mini.zip" | tail -1
cp "$ROOT/prototype/web/cheerpj/preload.json" "$OUT/preload.json"

rm -rf "$ADAPTER/target/verify-res"
"$JAVA" -cp "$OUT/forge-adapter.jar" mtgpuzzle.adapter.Solver --verify "$OUT/res-mini.zip" "$ADAPTER/target/verify-res" "$PUZZLES" 2>/dev/null \
  | grep -E "^(OK|NG|ALL|[0-9]+ FAILED)"
ls -la "$OUT"
