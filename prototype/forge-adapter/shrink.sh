#!/usr/bin/env bash
# forge-adapter-all.jar を ProGuard で縮め、スモークテストで壊れていないか確かめる（C2）。
# 使い方: ./shrink.sh <keep-mode>
#   all   … forge.** をすべて残す（安全側）
#   noai  … forge.ai.** は到達可能な部分だけ残す
#   game  … forge.game.** と forge.card.** だけ全部残し、それ以外は到達可能な部分だけ
# 前提: ~/tools/proguard/lib（ProGuard 7.10.0）、~/tools/jdk21-classes（jimage で書き出した JDK クラス）
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-all}"
JAVA_HOME="${FORGE_JAVA_HOME:-/c/Program Files/Android/Android Studio/jbr}"   # Java 17 以上が必要（システムの JAVA_HOME は使わない）
SEP=";"   # Windows の Java のクラスパス区切り

case "$MODE" in
  all)  KEEP='-keep class forge.** { *; }' ;;
  noai) KEEP=$'-keep class !forge.ai.**,forge.** { *; }' ;;
  game) KEEP=$'-keep class forge.game.** { *; }\n-keep class forge.card.** { *; }' ;;
  *) echo "unknown mode: $MODE"; exit 2 ;;
esac

CFG="target/proguard-$MODE.pro"
{
  cat proguard.pro
  echo "$KEEP"
  echo "-injars '$(cygpath -w "$PWD/target/forge-adapter-all.jar")'"
  echo "-outjars '$(cygpath -w "$PWD/target/forge-adapter-min-$MODE.jar")'"
  for j in ~/tools/jdk21-classes/*.jar; do echo "-libraryjars '$(cygpath -w "$j")'"; done
} > "$CFG"

CP=$(for j in ~/tools/proguard/lib/*.jar; do printf '%s%s' "$(cygpath -w "$j")" "$SEP"; done)
"$JAVA_HOME/bin/java" -cp "$CP" proguard.ProGuard "@$CFG" > "target/proguard-$MODE.log" 2>&1 || { tail -20 "target/proguard-$MODE.log"; exit 1; }

ls -la "target/forge-adapter-min-$MODE.jar"
rm -rf "target/smoke-res-$MODE"
"$JAVA_HOME/bin/java" -cp "target/forge-adapter-min-$MODE.jar" mtgpuzzle.adapter.Smoke ../web/res-mini.zip "target/smoke-res-$MODE" ../puzzles 2>&1 \
  | grep -E "^(OK|NG|ALL|[0-9]+ FAILED)|Exception|Error" | head -20
