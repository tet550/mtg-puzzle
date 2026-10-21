#!/usr/bin/env bash
# forge-game の jar の大きいメソッド（バイトコードの長さ）を、大きい順に出す（design/forge-overlay.md）。
# Forge を更新したときに、新しく大きくなったメソッド（CheerpJ で止まる候補）に気づくため。
#   使い方: tools/forge-overlay/method-sizes.sh [最小バイト数=3000] [jar=~/.m2 の forge-game]
#   前提: JAVA_HOME（javap を使う）
set -euo pipefail
MIN="${1:-3000}"
VERSION="$(sed -n 's:.*<forge.version>\(.*\)</forge.version>.*:\1:p' "$(dirname "$0")/../../prototype/forge-adapter/pom.xml")"
JAR="${2:-$HOME/.m2/repository/forge/forge-game/$VERSION/forge-game-$VERSION.jar}"
JAVAP="${JAVA_HOME:?JAVA_HOME を設定してください}/bin/javap"
[ -f "$JAR" ] || { echo "jar がありません: $JAR（forge-game を mvn install する）" >&2; exit 1; }

echo "# $(basename "$JAR") のメソッドのうち ${MIN} バイト以上"
unzip -Z1 "$JAR" | grep '\.class$' | sed 's/\.class$//; s#/#.#g' \
  | xargs "$JAVAP" -c -p -cp "$JAR" 2>/dev/null \
  | awk -v min="$MIN" '
      /^(public |private |protected |final |abstract |static |sealed |non-sealed )*(class|interface|enum|record) / {
        cls = $0; sub(/.*(class|interface|enum|record) /, "", cls); sub(/[ <{].*/, "", cls)
      }
      /^  [a-zA-Z].*\(.*\);$/ { name = $0; sub(/\(.*/, "", name); n = split(name, w, " "); name = w[n] }
      /^ +[0-9]+: / { split($1, a, ":"); last = a[1] + 0 }
      /^$/ { if (name != "" && last >= min) printf "%6d  %s.%s\n", last, cls, name; name = ""; last = 0 }
    ' \
  | sort -rn
