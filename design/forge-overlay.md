# Forge のクラスの上書き（CheerpJ で止まる問題への対処）

ブラウザ（CheerpJ 4.3）で、Forge の `Card.keywordsToText` を同じページで一定回数呼んだあとに、ゲームが止まる。
forge-adapter のビルドで、このメソッドを小さなメソッドに分けた `Card` を Forge のソースから作り、forge-game の `Card` を上書きして避けている。
Forge のサブモジュールには手を入れない。

## 1. 何が起きるか

| 項目 | 内容 |
|---|---|
| 症状 | 操作のあと「エンジンが応答しません（30 秒）」になる。直前まで遅くなる気配は無く、突然止まる |
| 起きる条件 | キーワード（速攻・警戒など）を持つカードの文面を作るたびに `keywordsToText` が呼ばれ、同じページでの回数が一定に達した次の呼び出しで止まる。回数は問題の切り替え・リセットでも積み上がり、再読み込み（Worker の作り直し）で戻る |
| 止まる場所 | `keywordsToText` に入った直後。その先の文に進まない。ゲームスレッドは動いたまま（RUNNABLE）で、イベントもログも出ない |
| 再現 | s11-redshift を 30 手進めてリセットすると、2 回目のリセットの途中で止まる（`app/e2e/engine-stall.spec.ts`） |
| JVM | 同じ手順は何千回でも止まらない。使用メモリ（約 66 MB）、作る文の長さ（約 155 文字）、呼び出しの深さはどれも増えない |

### 分かっていること・分かっていないこと

- **分かっている**: 止まるのは `keywordsToText` の中で、回数で起きる。分けると止まらない（上書きを外した版では E2E が失敗し、入れた版では通る）。Forge の処理の誤り・メモリ・文字の長さ・スタックではない。
- **推測**: CheerpJ がこのメソッドを JIT コンパイルするときの不具合（コンパイルが終わらない、または誤ったコードを作る）。CheerpJ の中は見えず、区別できていない。
- **分かっていない**: このメソッドの何が引き金か（大きさ 4.6 KB、ループの中の try/catch など）。もっと大きい `CardProperty.cardHasProperty`（14 KB）は、コンパイルに失敗する（コンソールに `JIT failure` と出る）が、止まらずに動き続ける。
- CheerpJ の設定では避けられない。`cheerpjInit` に JIT を止める・調整するオプションは無い。`enableDebug: true` のログにも、止まっている間は何も出ない。Java は 17 が必要なので、実行環境の版も下げられない。
- 別件の CheerpJ の不具合: 別スレッドのスタック（`Thread.getStackTrace`）を取ると、CheerpJ の中で TypeError が起き、`ArrayIndexOutOfBoundsException` になる。

## 2. 仕組み

| 部分 | 場所 | 内容 |
|---|---|---|
| 生成 | `tools/forge-overlay/generate.py` | `prototype/forge` の `Card.java` を読み、`keywordsToText` のループの中身を `keywordToText` に、その中の else-if の連なりを `keywordToTextPart0〜3` に分けて書き出す。動きは変えない（元の `continue` は `return i` / `Boolean.FALSE` にする） |
| ビルドへの組み込み | `prototype/forge-adapter/pom.xml` | `generate-sources` で生成し（exec-maven-plugin）、`target/generated-sources/forge-overlay` をソースに加える（build-helper-maven-plugin）。コンパイルした `Card` は jar で forge-game の `Card` より前に来る |
| 生成物 | `target/generated-sources/forge-overlay/` | **リポジトリに入れない**。ビルドのたびに、その時のサブモジュールのソースから作る（古いコピーが残ると、`Card` だけ別の版になる） |
| 版の確認 | `generate.py` | サブモジュールの Forge の版（`prototype/forge/pom.xml`）と、forge-adapter の `forge.version` が違えば止まる |
| 形の確認 | `generate.py` | 想定する形（メソッドの名前・引数、ループ、try、else-if の連なり、`continue` の位置、`i` と `keyword` の書き換え）と違えば、何が違うかを出して止まる。黙って元のクラスのままにはしない |
| 上書きが効いているか | `ForgeOverlayTest`（`mvn test`） | `Card` に `keywordToText` があり、forge-game の jar から読まれていないこと |
| ブラウザで止まらないか | `app/e2e/engine-stall.spec.ts` | s11 を 30 手進めてリセットを 6 回、最後に解き切る。Chrome だけで行う（約 20 秒）。上書きなしでは失敗する |
| 大きいメソッドの一覧 | `tools/forge-overlay/method-sizes.sh` | forge-game の jar のメソッドを、バイトコードの長さの大きい順に出す |

前提: Python 3（`python3`。無い環境では `-Dpython=python` などで指定する）。

## 3. Forge を更新する手順

1. サブモジュールを新しいタグにする。

   ```bash
   git -C prototype/forge fetch --depth 1 origin tag forge-2.0.16
   git -C prototype/forge checkout forge-2.0.16
   ```

   サブモジュールの向き先の変更は、`git add prototype/forge` でコミットに含める。`prototype/README.md` の「タグ … に固定」も直す。
2. `prototype/forge-adapter/pom.xml` の `forge.version` を同じ版にする。
3. forge-game を入れ直す（`prototype/README.md` の手順）。

   ```bash
   mvn -B -f prototype/forge/pom.xml -pl forge-game -am install -DskipTests -Dcheckstyle.skip
   ```

4. Adapter のテストを流す。ここで上書きを生成する。生成が止まったら「4. 生成が止まったとき」へ。

   ```bash
   mvn -B -f prototype/forge-adapter/pom.xml clean test
   ```

5. 大きいメソッドの一覧を出し、下の「5. 大きいメソッドの一覧」と比べる。新しく出てきた・大きくなったメソッドは、止まる候補として控えておく（すぐに分ける必要はない）。

   ```bash
   tools/forge-overlay/method-sizes.sh 3000
   ```

6. エンジンを作り直す。

   ```bash
   tools/build-engine.sh
   ```

7. ブラウザで確かめる。`engine-stall` が止まらないことと、同梱の問題が解けることを見る。

   ```bash
   cd app && npx playwright test e2e/engine-stall.spec.ts e2e/solve.spec.ts --project=chrome
   ```

8. この文書の「5. 大きいメソッドの一覧」と、確かめた Forge の版を更新する。

## 4. 生成が止まったとき

`[forge-overlay] エラー: ...` に、想定と違う所が出る。

| メッセージ | 対処 |
|---|---|
| サブモジュールの Forge は X、forge.version は Y | 手順 1〜3 をやり直して版をそろえる |
| keywordsToText が見つからない | Forge でメソッドの名前・引数が変わった。新しいソースを読み、`generate.py` の `sig` を合わせる。メソッドが無くなった・分けられたなら、上書きは不要かもしれない（「7. 上書きをやめるとき」で確かめる） |
| ループ・try・最初の文が想定と違う | 新しいソースの形に合わせて `split_keywords_to_text` を直す。ループの中身を別メソッドに移すこと、else-if の連なりを 4 つ程度に分けることが目的 |
| 外側のループに効く continue / break がある、i や keyword を書き換えている | 分けると動きが変わるおそれがある所。その枝のコードを読み、分けた先でも同じ動きになるように直す（今は `keyword = keyword.replace("Strike", "strike")` だけを許している。これは連なりの後の Flash / Backup の判定に影響しない） |

直したら手順 4 からやり直す。JVM のテストで動きが変わっていないことを、ブラウザの E2E で止まらないことを確かめる。

## 5. 大きいメソッドの一覧

Forge 2.0.15 の forge-game で、3000 バイト以上のメソッド（`tools/forge-overlay/method-sizes.sh 3000`）。

| バイト | メソッド | ブラウザでの様子 |
|---:|---|---|
| 14081 | `CardProperty.cardHasProperty` | JIT に失敗する（`JIT failure` が出る）が、止まらない |
| 10760 | `AbilityUtils.xCount` | 未確認 |
| 9042 | `CardFactoryUtil.addTriggerAbility` | 未確認 |
| 8390 | `CardFactoryUtil.addSpellAbility` | 未確認 |
| 5387 | `StaticAbilityContinuous.applyContinuousAbility` | 未確認 |
| 5031 | `ChangeZoneEffect.changeHiddenOriginResolve` | 未確認 |
| 4602 | `Card.keywordsToText` | **止まる → 上書きで分けている** |
| 3838 | `PlayerStatistics.playerHasProperty` | 未確認 |
| 3679 | `CardFactoryUtil.addReplacementEffect` | 未確認 |
| 3526 | `GameAction.changeZone` | s11 で何度も通っており、止まらない |
| 3215 | `CountersPutEffect.resolvePerType` | 未確認 |
| 3197 | `AbilityUtils.calculateAmount` | 未確認 |
| 3091 | `ChangeZoneEffect.changeKnownOriginResolve` | 未確認 |
| 3081 | `AbilityUtils.getDefinedPlayers` | 未確認 |

大きさだけでは止まるかどうかは決まらない（`cardHasProperty` は止まらず、それより小さい `keywordsToText` は止まる）。

## 6. 別のメソッドで止まったとき

1. 止まると、ブラウザのコンソールに、ゲームスレッドの状態と直前 40 件の Forge のイベントが出る（`ForgeSession.printGameThreadStack`）。CheerpJ では別スレッドのスタックは取れない。
2. 同じ手順を JVM で流し、同じイベントの所で何が呼ばれているかを調べる。JVM ではイベントごとに呼び出し元のスタックを取れる。
3. 疑わしい範囲の文の前に印を入れた一時的な上書きを作り、ブラウザで、最後に通った印を見る（今回は `GameAction.changeZone` → `CardView.updateState` → `Card.getAbilityText` → `Card.keywordsToText` と絞った）。印が進まなくなった所が、止まっているメソッド。
4. そのメソッドの分け方を `generate.py` の `OVERLAYS` に足す。`engine-stall.spec.ts` と同じように、止まる手順を E2E に足す。

## 7. 上書きをやめるとき

CheerpJ の新しい版で直ったかを確かめる。

1. `app/public/engine/worker.js` の CheerpJ の版（`loader.js` の URL）を上げる。
2. 上書きなしでエンジンを作る。`clean` は別に流す（`MAVEN_ARGS` に入れると、ProGuard の段階の mvn にも効いて、作った jar を消してしまう）。

   ```bash
   mvn -B -f prototype/forge-adapter/pom.xml clean
   MAVEN_ARGS="-Dforge.overlay=off" tools/build-engine.sh
   ```

3. `engine-stall.spec.ts` を流す。通れば、上書きをやめられる（`OVERLAYS` から外し、`ForgeOverlayTest` を消す）。失敗すれば、まだ直っていない。
4. どちらの場合も、最後に上書きありで作り直す（`mvn -B -f prototype/forge-adapter/pom.xml clean` のあと `tools/build-engine.sh`）。

## 8. 残っていること

- CheerpJ（Leaning Technologies）への報告。Forge を使わずに同じ形のメソッドだけで再現できれば、それを添える。
- 公式の Forge に、`keywordsToText` を分ける変更を PR として出すか（動きを変えない整理）。取り込まれれば、この上書きは要らなくなる。
