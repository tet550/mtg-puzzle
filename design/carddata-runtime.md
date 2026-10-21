# 問題ごとのカードの読み込みと、実行時の画像の取得

対象: エディターで作った問題を URL で渡す方式（問題に入るカードが前もって分からない）。静的サイトのまま動かす。

## 決めたこと

- **エンジンのカード**: ビルド時に全カードのデータを 1 ファイル（`carddata-<hash>.json.gz`）にまとめて置く。ブラウザは問題を開くたびに、そこから問題のカードと依存するもの（カード・トークン）だけを抜き出して、Forge を初期化し直す。
  - まずは分割せず全件を 1 回取得する（gzip で約 9 MB。一度読めばブラウザのキャッシュに残る）。重ければ分割を考える（ハッシュ・エディション単位などの比較は下の「残っていること」）。
- **画像**: 同梱の問題のカードはビルド時の一覧（`public/cards.json`）を使う。一覧に無いカードは、問題を開いたときに Scryfall の API で引き、端末（localStorage）に覚える。

## エンジンのカード

### なぜ全カードを Forge に読ませないか

Forge の全カード（スクリプト 33,980 個、24.7 MB）を初期化で読むと、JVM でも 3.8 秒かかる（[v1.md](../prototype/results/v1.md)）。CheerpJ ではその何倍もかかる。Forge の遅延ロードも、起動時に名前の索引を作るために全カードを解析するので使えない。

そのため、Forge には **問題のカードだけ** を読ませる。これは今までの res バンドル（`ResBundler`、同梱の問題のカードだけを zip にする）と同じ考え方で、その「抜き出し」をビルド時から問題を開くときに移した。

### ビルド時（`tools/build-engine.sh` → `CardData.java`）

| 出力 | 中身 |
|---|---|
| `res-base-<hash>.zip`（約 140 KB） | カード以外の res（blockdata・setlookup・型リスト・en-US の文言） |
| `carddata-<hash>.json.gz`（約 9 MB） | 全カードのスクリプト、カードごとのエディション・日本語の訳・依存するカードとトークン、全トークンのスクリプト |

カードデータの形:

```ts
{
  forge: "2.0.15",
  keys: Record<string, number>,        // カード名（全部の面、小文字）→ cards の番号
  cards: {
    f: string;                         // cardsfolder のファイル名
    s: string;                         // スクリプト
    e?: string;                        // エディションのファイル名（Core / Expansion で最も古いもの。ResBundler と同じ選び方）
    d?: string[];                      // 依存するカード（小文字）。MeldPair・CopyFaceFrom と、MakeCard などの Name$ / Names$ / DefinedName$ / Spellbook$
    t?: string[];                      // 作るトークン（TokenScript$）
    j?: string;                        // cardnames-ja-JP.txt の行
  }[],
  editions: Record<string, string>,    // エディションのファイル名 → 中身
  tokens: Record<string, { s: string; t?: string[] }>,
  alwaysTokens: string[],              // どの問題にも入れるトークン（ダンジョン、Forge のコードが名前で作る Army・Empower・Spirit）
}
```

### 問題を開くとき

1. メインスレッド（`ForgeEngine.load`）が問題のカード名を集め、前の問題と組が違えば Worker に `useCards` を頼む。
2. Worker（`public/engine/worker.js`）がカードデータを読み（初回だけ。Worker の中に置いておく）、`selectCards` で問題のカードと依存するものを抜き出す。
3. Java の `WebApi.useCards` が res の `cardsfolder`・`editions`・`tokenscripts`・日本語の訳を書き換え、`ForgeRuntime.reload` で静的データを作り直す。
4. それから `load` で問題を読み込む。

起動時（`start`）は CheerpJ の起動と共通の res の展開（`prepare`）だけを行う。Forge の初期化は問題が決まってから。

JVM でも同じ流れを確かめる: `Solver --verify <res-base.zip> <dir> <puzzles> <carddata.json.gz>`（`CardData.select` は `selectCards` と同じ処理）。同梱の問題を続けて読むので、初期化し直しの確かめにもなる。

### 計測（2026-10-21、Chrome、`scripts/measure.mjs`、S1 を開いて操作できるまで）

| | 初回 | 2 回目以降 | Forge の初期化 |
|---|---|---|---|
| 変更前（同梱の問題のカードの res バンドル） | 14.8 秒 | 9.6〜10.2 秒 | 4.3〜4.8 秒 |
| 変更後（問題のカードだけ） | 13.4 秒 | 8.6〜8.9 秒 | 2.5〜2.6 秒 |

- Forge の初期化は、読むカードが減ったぶん短くなった。カードデータの読み込みと抜き出しは 0.3〜0.4 秒。
- 最初は全トークン（854 個）を共通の res に入れていたが、初期化が 3.8 秒かかったので、トークンも問題ごとに抜き出すようにした。
- 同じページで別の問題に切り替えると、初期化し直しは 0.1〜0.4 秒（2 回目以降は JIT が効く）。
- 初回はカードデータ（約 9 MB）のダウンロードが加わる。回線が遅い端末ではここが重くなるので、実機で確かめる。

### 扱えないカード

- 「カード名を 1 つ選ぶ」「すべてのカードの中から無作為に」のように、どのカードでもよい効果（`CopyFromChosenName`、`AnySupportedCard` など）。問題のカードしか Forge に無いので、選べるのはその中だけになる（今までの res バンドルと同じ制限）。
- 依存の読み取りはスクリプトの決まったキーだけを見ている。漏れがあれば、そのカードを使う問題で「存在しないカード」やトークンが作られない形で表に出る。

## 画像（`app/src/ui/images.ts`）

- 起動時に `cards.json` と、端末に覚えた分（`mtg-puzzle.cardImages.v1`）を読む。
- 問題を開いたとき（`PlayPage.load`）に、どちらにも無いカードを Scryfall で引く（`ensureCardImages`）。引き方は `tools/card-images.py` と同じ:
  - 英語版: `POST /cards/collection`（75 枚ずつ、1 問ならふつう 1 回）
  - 日本語版: カードごとに `GET /cards/search?q=!"名前" lang:ja`（100 ms ずつ空ける）。通常の版で最新のもの、無ければ特殊な版
- 見つからなかったカードも覚えておき、毎回は引かない。分かったら盤面を描き直す。通信できなくても文字のカードで遊べる。
- 画像そのものは今まで通り Scryfall の画像 CDN から読む。

## 残っていること

- カードデータの分割（初回の 9 MB が重い場合）。箱に関連が無いハッシュ分割はキャッシュが当たりにくい（同梱の 13 問で 22%）ので、分けるなら「初回は必要な箱だけ、後で全部を取る」形を考える。
- ゲーム中に作られるトークンの画像（今までと同じく出ない）。
- Forge を更新したときのカードデータの作り直しと、古い URL の問題を前の版で遊べるようにするか（`engine.version` ごとに置くか）。
