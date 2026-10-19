#!/usr/bin/env bash
# forge-adapter-all.jar を ProGuard で縮め、スモークテストで壊れていないか確かめる（C2）。
# 使い方: ./shrink.sh <keep-mode>
#   all   … forge.** をすべて残す（安全側）
#   noai  … forge.ai.** は到達可能な部分だけ残す
#   game  … forge.game.** と forge.card.** だけ全部残し、それ以外は到達可能な部分だけ
# 前提: JAVA_HOME（または FORGE_JAVA_HOME）が Java 17 以上。mvn が PATH にある。
#   ProGuard 7.10.0 は初回に Maven で target/proguard-lib へ取ってくる。
#   JDK のクラスは $JAVA_HOME/jmods を使う。jmods の無い JDK（Android Studio の JBR など）では
#   ~/tools/jdk21-classes（jimage で書き出した JDK クラスの jar。手順は results/cheerpj.md）を使う。
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-all}"
JAVA_HOME="${FORGE_JAVA_HOME:-${JAVA_HOME:?JAVA_HOME を Java 17 以上に設定してください}}"

# Windows（Git Bash）では Java に Windows のパスとクラスパス区切りを渡す
if command -v cygpath > /dev/null; then
  native() { cygpath -w "$1"; }
  SEP=";"
else
  native() { printf '%s' "$1"; }
  SEP=":"
fi

case "$MODE" in
  all)  KEEP='-keep class forge.** { *; }' ;;
  noai) KEEP=$'-keep class !forge.ai.**,forge.** { *; }' ;;
  game) KEEP=$'-keep class forge.game.** { *; }\n-keep class forge.card.** { *; }' ;;
  *) echo "unknown mode: $MODE"; exit 2 ;;
esac

PG_LIB=target/proguard-lib
if ! ls "$PG_LIB"/proguard-base-*.jar > /dev/null 2>&1; then
  mvn -B -q dependency:copy-dependencies -f proguard-deps.xml -DoutputDirectory="$PWD/$PG_LIB"
fi

if [ -d "$JAVA_HOME/jmods" ]; then
  LIBS=()
  for m in java.base java.logging java.management java.sql java.naming java.xml java.desktop jdk.unsupported; do
    LIBS+=("'$(native "$JAVA_HOME/jmods/$m.jmod")'(!**.jar;!module-info.class)")
  done
else
  LIBS=()
  for j in ~/tools/jdk21-classes/*.jar; do LIBS+=("'$(native "$j")'"); done
fi

CFG="target/proguard-$MODE.pro"
{
  cat proguard.pro
  echo "$KEEP"
  echo "-injars '$(native "$PWD/target/forge-adapter-all.jar")'"
  echo "-outjars '$(native "$PWD/target/forge-adapter-min-$MODE.jar")'"
  for l in "${LIBS[@]}"; do echo "-libraryjars $l"; done
} > "$CFG"

CP=$(for j in "$PG_LIB"/*.jar; do printf '%s%s' "$(native "$PWD/$j")" "$SEP"; done)
"$JAVA_HOME/bin/java" -cp "$CP" proguard.ProGuard "@$CFG" > "target/proguard-$MODE.log" 2>&1 || { tail -20 "target/proguard-$MODE.log"; exit 1; }

ls -la "target/forge-adapter-min-$MODE.jar"
rm -rf "target/smoke-res-$MODE"
"$JAVA_HOME/bin/java" -cp "target/forge-adapter-min-$MODE.jar" mtgpuzzle.adapter.Smoke ../web/res-mini.zip "target/smoke-res-$MODE" ../puzzles 2>&1 \
  | grep -E "^(OK|NG|ALL|[0-9]+ FAILED)|Exception|Error" | head -20
