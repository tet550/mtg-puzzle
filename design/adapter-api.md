# Forge Adapter API v1

対象: [phase1-plan.md](phase1-plan.md) の M1（Phase 0 の A7）
実装: `prototype/forge-adapter`（Java の `WebApi`）。TS 側のクライアントは `app/src/engine/` に置く。

## 0. 呼び出し方

- ブラウザでは Web Worker の中で CheerpJ を起動し、`mtgpuzzle.adapter.WebApi` の static メソッドを呼ぶ。引数と戻り値は **JSON 文字列**。
- 呼び出しは 1 つずつ順番に行う（並行して呼ばない）。`load` / `submit` / `reset` は、Forge が次に p1 の選択を待つか、終局・停止するまで戻らない。
- エラーはどのメソッドでも `{"error": {"code", "message"}}` の形で返る（例外は投げない）。

| メソッド | 引数 | 戻り値 |
|---|---|---|
| `version()` | なし | `VersionInfo` |
| `init(zipPath, extractDir)` | res バンドルの zip（`/app/...`）と展開先（`/files/...`） | `InitResult` |
| `load(puzzleJson)` | 問題データ（schemaVersion 1）の JSON | `StepResult` |
| `submit(optionIdsJson)` | 選んだ選択肢の ID の配列（JSON） | `StepResult` |
| `reset()` | なし | `StepResult`（初期盤面から作り直す） |
| `state()` | なし | `GameView` |

## 1. 型（TypeScript）

```ts
type PlayerId = string;      // 問題のプレイヤー ID（"p1" / "p2"）
type InstanceId = string;    // 問題のカードのインスタンス ID。問題に無いカード（トークンなど）は "f" + Forge の ID
type Zone = "Hand" | "Battlefield" | "Graveyard" | "Exile" | "Stack";
type Phase = "UNTAP" | "UPKEEP" | "DRAW" | "MAIN1" | "COMBAT_BEGIN" | "COMBAT_DECLARE_ATTACKERS"
  | "COMBAT_DECLARE_BLOCKERS" | "COMBAT_FIRST_STRIKE_DAMAGE" | "COMBAT_DAMAGE" | "COMBAT_END"
  | "MAIN2" | "END_OF_TURN" | "CLEANUP";

interface ApiError { error: { code: ErrorCode; message: string } }
type ErrorCode =
  | "INVALID_PUZZLE"   // 問題データが不正（JSON が壊れている・存在しないカード・未対応の schemaVersion など）
  | "INVALID_ANSWER"   // 選択肢にない ID・選択数が範囲外・ID の重複。選択待ちの状態はそのまま残る
  | "NO_PENDING"       // 選択待ちが無いのに submit した（終局後など）
  | "NOT_LOADED"       // load の前に submit / reset / state を呼んだ
  | "INTERNAL";        // それ以外（Java の例外）

interface VersionInfo { api: 1; forge: string }

interface InitResult {
  extractMs: number; extractCached: boolean; files: number;
  initMs: number; initPhases: Record<string, number>; heapUsedMB: number;
}

interface StepResult {
  engine: EngineState;
  pending: Decision | null;    // engine.state が AWAITING のときだけ
  events: GameEvent[];         // 前の呼び出しから今回までに起きた出来事（起きた順）
  view: GameView;              // 今の盤面（毎回全体）
  fallback: string[];          // 既定の答えを返した選択の記録（空でなければ、問題が未対応の選択を含む）
  elapsedMs: number;
  javaJudge: { status: "IN_PROGRESS" | "CLEARED" | "FAILED" | "ERROR"; reason: string }; // 照合用。UI の判定には使わない
}

type EngineState =
  | { state: "AWAITING" }                        // p1 の選択待ち
  | { state: "GAME_OVER"; outcome: { winner: PlayerId | null; draw: boolean; winCondition: string } }
  | { state: "HALTED" }                          // 期限（このターン）を過ぎたので止めた
  | { state: "ERROR"; message: string };         // エンジンの異常。reset で復帰できる
```

### 盤面（GameView）

```ts
interface GameView {
  turn: number;
  phase: Phase;
  activePlayer: PlayerId;
  priorityPlayer: PlayerId | null;
  stack: StackItem[];          // index 0 が一番上
  combat: Attack[];            // 戦闘中でなければ空
  players: PlayerView[];
}

interface PlayerView {
  id: PlayerId;
  life: number;
  poison: number;
  manaPool: Partial<Record<"W" | "U" | "B" | "R" | "G" | "C", number>>;
  handCount: number;
  libraryCount: number;
  cards: CardView[];           // 手札（問題を解くプレイヤーだけ）・戦場・墓地・追放・スタック上の呪文。ライブラリーは含まない
}

interface CardView {
  instanceId: InstanceId;
  name: string;
  zone: Zone;
  owner: PlayerId;
  controller: PlayerId;
  kinds: ("land" | "creature" | "artifact" | "enchantment" | "planeswalker" | "battle" | "instant" | "sorcery")[];
  typeLine: string;            // 例: "Creature - Giant"
  manaCost: string;            // 例: "{3}{R}"。土地は "no cost"
  text: string;                // ルール文（Oracle）
  power: number | null;        // クリーチャーのときだけ。現在の値
  toughness: number | null;
  basePower: number | null;
  baseToughness: number | null;
  damage: number;
  tapped: boolean;
  sick: boolean;               // 召喚酔い
  token: boolean;
  faceDown: boolean;
  counters: Record<string, number>;   // 例: { "P1P1": 2 }
  attachedTo: InstanceId | PlayerId | null;
  exiledBy: InstanceId | null;
}

interface StackItem {
  index: number;
  sourceId: InstanceId;        // 呪文はそのカード、能力は発生源
  controller: PlayerId;
  description: string;
  spell: boolean;
  targets: (InstanceId | PlayerId)[];
}

interface Attack { attackerId: InstanceId; defender: PlayerId | InstanceId; blockers: InstanceId[] }
```

- 相手の手札とライブラリーは枚数だけ（D9。UI でも最小限にする）。ライブラリーは自分の分も枚数だけ。

### 選択要求（Decision）

```ts
interface Decision {
  seq: number;
  kind: DecisionKind;
  prompt: string;              // 英語の説明（Forge の文）。UI は kind と ref から自前の文を作る
  min: number;                 // 選ぶ数の範囲。submit には min〜max 個の ID を渡す
  max: number;
  options: Option[];
}

type DecisionKind =
  | "PRIORITY"       // 唱える・起動する・土地を出す、または "pass"
  | "TARGETS"        // 対象を選ぶ（対象を取る能力 1 つごとに 1 回）
  | "ATTACKERS"      // 攻撃するクリーチャーを選ぶ（0 体も可）
  | "CONFIRM"        // "yes" / "no"（任意の誘発、任意の処理）
  | "PAY_MANA"       // マナ源を 1 つ選ぶ。"auto" で残りを自動、"cancel" で唱える前に戻る
  | "CHOOSE_CARDS"   // コストに使うカード（生け贄・捨てるなど）
  | "CHOOSE_ENTITY"  // 効果で選ぶカード・プレイヤー（対象を取らない選択）
  | "CHOOSE_MODE"    // モードを選ぶ（min〜max 個）
  | "CHOOSE_NUMBER"; // 数を選ぶ（X など）。上限の無い数は 21 個までの選択肢に区切る

interface Option { id: string; label: string; ref: Ref | null }

type Ref =
  | { type: "card"; cardId: InstanceId }
  | { type: "player"; player: PlayerId }
  | { type: "ability"; cardId: InstanceId; abilityKind: "spell" | "activated" | "land" }
  | { type: "stack"; index: number }
  | { type: "special"; value: "pass" | "auto" | "cancel" | "yes" | "no" };
```

- `id` は選択要求の中だけで意味を持つ（次の選択要求では同じ ID が別のものを指しうる）。UI は `ref` で盤面のカードと結び付ける。
- PRIORITY では、1 枚のカードに複数の選択肢（呪文として唱える／起動型能力など）が付くことがある。

### 出来事（GameEvent）

```ts
type GameEvent =
  | { type: "turnBegan"; turn: number; player: PlayerId }
  | { type: "phase"; phase: Phase; player: PlayerId }
  | { type: "cast"; sourceId: InstanceId; controller: PlayerId | null; description: string }
  | { type: "resolved"; sourceId: InstanceId; description: string; fizzled: boolean }
  | { type: "life"; player: PlayerId; from: number; to: number }
  | { type: "damage"; sourceId: InstanceId | null; target: PlayerId | InstanceId; amount: number; combat: boolean }
  | { type: "zoneChange"; cardId: InstanceId; from: string | null; to: string | null }
  | { type: "tapped"; cardId: InstanceId; tapped: boolean }
  | { type: "counters"; cardId: InstanceId; counter: string; from: number; to: number }
  | { type: "attackersDeclared"; attackers: { cardId: InstanceId; defender: PlayerId | InstanceId }[] }
  | { type: "gameOver"; winner: PlayerId | null };
```

- 盤面の復元（`load` / `reset` の最初）で起きた出来事は含まない。
- 期限を過ぎた（次のターンが始まった）ときは、その `turnBegan` までを返し、エンジンを止めて `HALTED` にする。

## 2. 進行の決まり

- **優先権を問い合わせるステップ**: スタックが空のときは、自分のターンの MAIN1・攻撃宣言・ブロック宣言・MAIN2・終了ステップだけ問い合わせる。ほかのステップ（アップキープ・戦闘開始など）と相手のターンは自動でパスする。スタックが空でなければ、どのステップでも問い合わせる（解決を 1 つずつ見せるため）。問題の開始時点の最初の優先権は、どのステップでも問い合わせる。
- **相手（p2）**: 常にパスし、攻撃もブロックもしない。強制的な選択には先頭から必要数を選び、`fallback` に記録する。
- **期限**: 開始したターンより後のターンが始まった時点で止める（`HALTED`）。その時点で勝敗が決まっていなければ、UI は失敗として扱う。
- **リセット**: 同じ問題データからゲームを作り直す（約 15〜60 ms）。インスタンス ID は変わらない。

## 3. 既知の制限

- 同じモードを複数回選ぶモード（`allowRepeat`）、ダメージの割り振り、同時誘発の順序、トークンの名前の選択などは未対応。既定の答えを返し、`fallback` に記録する。
- 未対応のコスト（12 種）は支払えないものとして扱う（`results/cheerpj.md` の C3。Forage は対応した）。
  パワーの合計の条件付きのタップ（搭乗など）と、カウンターを取り除くコスト（プレインズウォーカーのマイナス能力など）は対応している。
- コストのカードを選ぶ選択要求（CHOOSE_CARDS）には "cancel" が付く。"cancel" だけを送ると、選択数の範囲に関係なく受け付け、唱える・起動する前に戻す。
- 召集・即席（chooseCardsForConvokeOrImprovise）は未対応で、通常のマナで支払う。
- `prompt` と `label` は Forge の英語の文。UI の表示には `kind` と `ref` を使う。
