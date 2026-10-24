#!/usr/bin/env bash
# エンジン一式を作り、app/public/engine/ に置く（Phase 1 M2）。
#   1. forge-adapter の依存込み jar を作る
#   2. ProGuard で縮め、スモークテストを通す
#   3. カードを含まない共通の res バンドルと、全カードのデータ（.json.gz）を作る（CardData、design/carddata-runtime.md）
#      ブラウザは問題を開くたびに、カードデータから問題のカードだけを抜き出して Forge を初期化する
#   4. 解答手順（*.solution.json）がある問題を、縮めた jar とブラウザと同じ流れ（問題ごとに初期化し直す）で解き直して確かめる
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
TMP="$ADAPTER/target/engine-out"
rm -rf "$TMP" && mkdir -p "$TMP"
"$JAVA" -cp "$ADAPTER/target/forge-adapter-all.jar" mtgpuzzle.adapter.CardData "$RES" "$TMP/res-base.zip" "$TMP/carddata.json.gz"

rm -rf "$ADAPTER/target/verify-res"
"$JAVA" -cp "$ADAPTER/target/forge-adapter-min-all.jar" mtgpuzzle.adapter.Solver --verify "$TMP/res-base.zip" "$ADAPTER/target/verify-res" "$PUZZLES" "$TMP/carddata.json.gz" 2>/dev/null \
  | grep -E "^(OK|NG|ALL|[0-9]+ FAILED)"

# ファイル名に中身のハッシュを付けて置く。CheerpJ は /app/ のファイルを URL ごとに保存するので、
# 同じ名前で中身を差し替えると古いものが読まれる（公開後のキャッシュも同じ）。どれを読むかは manifest.json で渡す
hash() { (shasum -a 256 "$1" 2>/dev/null || sha256sum "$1") | cut -c1-12; }
JAR="forge-adapter-$(hash "$ADAPTER/target/forge-adapter-min-all.jar").jar"
ZIP="res-base-$(hash "$TMP/res-base.zip").zip"
CARDS="carddata-$(hash "$TMP/carddata.json.gz").json.gz"
rm -f "$OUT"/forge-adapter*.jar "$OUT"/res-mini*.zip "$OUT"/res-base*.zip "$OUT"/carddata*.json.gz
cp "$ADAPTER/target/forge-adapter-min-all.jar" "$OUT/$JAR"
cp "$TMP/res-base.zip" "$OUT/$ZIP"
cp "$TMP/carddata.json.gz" "$OUT/$CARDS"
cp "$ROOT/prototype/web/cheerpj/preload.json" "$OUT/preload.json"
printf '{\n  "jar": "%s",\n  "res": "%s",\n  "cards": "%s",\n  "preload": "preload.json"\n}\n' "$JAR" "$ZIP" "$CARDS" > "$OUT/manifest.json"
ls -la "$OUT"
