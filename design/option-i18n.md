# 選択肢の日本語化（方式の検討）

対象: 操作パネル・メニュー・スタック・Log に出る、エンジン（Forge）由来の英語の文。
前提: 画面の固定の文言は日本語・英語に対応済み（`app/src/i18n`、D10）。カード名・カードの画像・印刷された文は Scryfall の日本語版を使っている。

## 1. いま英語で出ているもの

| 出どころ | 例 | 作っている所 |
|---|---|---|
| 唱える・起動する選択肢（PRIORITY） | `Lightning Bolt \| Lightning Bolt deals 3 damage to any target.` | Forge の `SpellAbility.toString()` |
| モードの選択肢（CHOOSE_MODE） | `Destroy target artifact.` | Forge の `AbilitySub.getDescription()` |
| マナ源の選択肢（PAY_MANA） | `Submerged Boneyard (8): {T}: Add {U} or {B}.` | Forge のマナ能力の説明 |
| 対象・カードの選択肢 | `Ornithopter (Battlefield, p2)` | Adapter（UI 側で名前だけ日本語にしている） |
| 選択要求の説明（prompt） | `Choose targets for Lightning Bolt: …`、`Pay {1}{B} for …`、Forge の効果の文 | Adapter と Forge が混在 |
| スタックの項目・Log | `Terminate (5) - Destroy target creature…` | Forge の `getStackDescription()` |

## 2. 調べたこと（Forge 2.0.15）

- Forge 本体に日本語の資源がある。
  - `res/languages/cardnames-ja-JP.txt`（8.8 MB、約 2.6 万枚）: `英語名|日本語名|日本語のタイプ|日本語のルール文`
  - `res/languages/ja-JP.properties`（224 KB、4,017 個）: Forge の画面と効果の文言（`lblCrew=搭乗` など）
- `CardTranslation.preloadTranslation("ja-JP", dir)` を**カードを読む前に**呼ぶと、カードを読むときに「英語のオラクルの行 ↔ 日本語の文の行」の対応表を作り、`SpellAbility.toString()` などが日本語を返す。`Localizer.setLanguage("ja-JP", dir)` で Forge の文言も日本語になる。
- 同梱の 12 問のカードの全能力（175 個）で試した結果:

| 結果 | 数 | 例 |
|---|---|---|
| 全部日本語になる | 146（83%） | `クリーチャー１体を対象とし、それを破壊する。それは再生できない。`、`装備{2}`、`{T}：{U}か{B}を加える。` |
| 一部だけ | 1 | `Rashka the Slayer - クリーチャー 3 / 3`（名前は UI 側で直せる） |
| 訳されない | 28 | 基本土地のマナ `{G}`（訳す必要なし）、パーマネント呪文の名前だけのもの（UI 側で直せる）、他のカードから与えられた能力（Ygra の食物）、キーワードの注釈（搭乗）、対応表が古いカード（致命的な一押し・Pile On） |

- モードの選択肢は、Adapter が `getDescription()` をそのまま使っているため訳されていない（Adapter で `CardTranslation.translateSingleDescriptionText` を通せば訳される）。
- 言語は Java の中で 1 つ（static）。日本語の対応表は、カードを読むときに作られる。

## 3. 方式の比較

| 方式 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A. Forge の訳を使う**（推奨） | 初期化の前に日本語の訳を読み込み、Adapter が選択肢・説明・スタックの文を**英語と日本語の両方**で返す。UI は画面の言語で選ぶ | 公式の日本語の文（印刷された文）がそのまま出る。8 割以上がこれだけで日本語になる。追加の辞書の手入れがほぼ要らない | 訳の対応表が古いカード・与えられた能力・キーワードの注釈は英語のまま。対応表を作るため、日本語の資源を同梱する（問題のカードの分だけに絞れば数十 KB） |
| B. 画面側で Scryfall の日本語の文と突き合わせる | 能力と印刷された文の行を、並び順やコストの書き方で対応付ける | Java の変更が要らない | 行の並びと能力の並びが合わないことが多く、取り違えると誤った説明になる |
| C. 効果の種類ごとの日本語の雛形 | Java が効果の種類（ダメージ・破壊・強化など）と数値を返し、画面側が雛形で文を作る | 訳の対応表に頼らない | 効果の種類が多く（数百）、カード固有の文を表せない。手間が大きい |
| D. 機械翻訳（ビルド時） | 英語の文を翻訳サービス・LLM で訳しておく | すべて日本語になる | 要件で LLM を使わない方針。用語の揺れ・誤訳の確認が要る。外部サービスの費用と規約 |

## 4. 推奨: A を主にし、足りない所を小さく補う

1. **Adapter が両方の言語で返す**（Java）
   - 初期化の前に `CardTranslation.preloadTranslation("ja-JP")` を呼び、対応表を作る。
   - 選択肢の `label` と別に `labelJa` を返す。英語の文は、訳の言語の切り替え（static の値）を一時的に英語にして作る。言語を切り替えるたびに資源を読み直さない。
   - モードの選択肢・スタックの文・カードのルール文（`textJa`）も同じく両方で返す。
   - Adapter が自分で作る説明（`Choose targets for …`、`Pay … for …`、搭乗の説明など）は文にせず、**種類と値**（例: `{ key: "targets", card: "c1" }`）で返し、画面側の辞書（`app/src/i18n`）で文にする。
2. **資源の同梱**: `ResBundler` で `cardnames-ja-JP.txt` を問題のカードの行だけに絞り、`ja-JP.properties` と一緒に res バンドルに入れる。
3. **補い**（画面側の小さな辞書）: 搭乗・装備・食物・宝物・手掛かりなど、よく出るキーワード能力と与えられる能力だけを雛形で日本語にする。それ以外で英語のまま残るものは、英語の文に日本語のカード名を差し込んで出す（今と同じ）。
4. **確認**: 同梱の問題で、訳されない選択肢の数を数える道具（今回の調査に使ったもの）を `Fuzz` と同じく置き、問題を増やしたときに確かめる。

### 見込み

| 作業 | 目安 |
|---|---|
| Java（両方の言語で返す、説明を種類と値で返す） | 0.5〜1 日 |
| res バンドルへの日本語の資源の追加 | 0.5 日 |
| 画面（label / labelJa の出し分け、雛形の辞書） | 0.5 日 |

### 決めておくこと

- 日本語の資源（Forge の `cardnames-ja-JP.txt`）は Forge と同じく GPL-3.0 で配る（ライセンスの整理 V7 に含める）
- Forge の日本語の文（印刷された文）と、Scryfall の日本語の文が食い違うときにどちらを出すか（推奨: 選択肢は Forge、カードの詳細は Scryfall の印刷された文）
