// Forge Adapter API v1 の型（design/adapter-api.md と同じ）。Java の WebApi が返す JSON の形。

export const API_VERSION = 1;

export type PlayerId = string;
/** 問題のカードのインスタンス ID。問題に無いカード（トークンなど）は "f" + Forge の ID */
export type InstanceId = string;
export type Zone = "Hand" | "Battlefield" | "Graveyard" | "Exile" | "Stack";
export type Phase =
  | "UNTAP" | "UPKEEP" | "DRAW" | "MAIN1" | "COMBAT_BEGIN" | "COMBAT_DECLARE_ATTACKERS"
  | "COMBAT_DECLARE_BLOCKERS" | "COMBAT_FIRST_STRIKE_DAMAGE" | "COMBAT_DAMAGE" | "COMBAT_END"
  | "MAIN2" | "END_OF_TURN" | "CLEANUP";

export type ErrorCode = "INVALID_PUZZLE" | "INVALID_ANSWER" | "NO_PENDING" | "NOT_LOADED" | "INTERNAL";

export interface ApiError {
  error: { code: ErrorCode; message: string };
}

export interface VersionInfo {
  api: number;
  forge: string;
}

export interface InitResult {
  extractMs: number;
  extractCached: boolean;
  files: number;
  initMs: number;
  initPhases: Record<string, number>;
  heapUsedMB: number;
}

export type EngineState =
  | { state: "AWAITING" }
  | { state: "GAME_OVER"; outcome: { winner: PlayerId | null; draw: boolean; winCondition: string } }
  | { state: "HALTED" }
  | { state: "ERROR"; message: string };

export interface StepResult {
  engine: EngineState;
  pending: Decision | null;
  events: GameEvent[];
  view: GameView;
  fallback: string[];
  elapsedMs: number;
  /** Java 側の判定（照合用。UI の判定には使わない） */
  javaJudge: { status: "IN_PROGRESS" | "CLEARED" | "FAILED" | "ERROR"; reason: string };
}

export interface GameView {
  turn: number;
  phase: Phase;
  activePlayer: PlayerId;
  priorityPlayer: PlayerId | null;
  stack: StackItem[];
  combat: Attack[];
  players: PlayerView[];
}

export type ManaColor = "W" | "U" | "B" | "R" | "G" | "C";

export interface PlayerView {
  id: PlayerId;
  life: number;
  poison: number;
  manaPool: Partial<Record<ManaColor, number>>;
  handCount: number;
  libraryCount: number;
  cards: CardView[];
}

export type CardKind = "land" | "creature" | "artifact" | "enchantment" | "planeswalker" | "battle" | "instant" | "sorcery";

export interface CardView {
  instanceId: InstanceId;
  name: string;
  zone: Zone;
  owner: PlayerId;
  controller: PlayerId;
  kinds: CardKind[];
  typeLine: string;
  manaCost: string;
  text: string;
  power: number | null;
  toughness: number | null;
  basePower: number | null;
  baseToughness: number | null;
  damage: number;
  tapped: boolean;
  sick: boolean;
  token: boolean;
  faceDown: boolean;
  counters: Record<string, number>;
  attachedTo: InstanceId | PlayerId | null;
  exiledBy: InstanceId | null;
}

export interface StackItem {
  index: number;
  sourceId: InstanceId;
  controller: PlayerId;
  description: string;
  /** 日本語の文（Forge の訳。訳が無ければ null） */
  descriptionJa?: string | null;
  spell: boolean;
  targets: (InstanceId | PlayerId)[];
}

export interface Attack {
  attackerId: InstanceId;
  defender: PlayerId | InstanceId;
  blockers: InstanceId[];
}

export type DecisionKind =
  | "PRIORITY" | "TARGETS" | "ATTACKERS" | "CONFIRM" | "PAY_MANA"
  | "CHOOSE_CARDS" | "CHOOSE_ENTITY" | "CHOOSE_MODE" | "CHOOSE_NUMBER";

export interface Decision {
  seq: number;
  kind: DecisionKind;
  /** 英語の説明。promptKey があれば、画面の言語の文は promptKey と promptArgs から作る */
  prompt: string;
  promptKey?: string | null;
  promptArgs?: Record<string, string>;
  min: number;
  max: number;
  options: Option[];
}

export interface Option {
  id: string;
  label: string;
  /** 日本語の文（Forge の訳。訳せない・訳が無ければ null） */
  labelJa?: string | null;
  ref: Ref | null;
}

export type SpecialValue = "pass" | "auto" | "cancel" | "yes" | "no";

export type Ref =
  | { type: "card"; cardId: InstanceId }
  | { type: "player"; player: PlayerId }
  | { type: "ability"; cardId: InstanceId; abilityKind: "spell" | "activated" | "land" }
  | { type: "stack"; index: number }
  | { type: "special"; value: SpecialValue };

export type GameEvent =
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

/** Worker とメインスレッドの間のメッセージ */
export type WorkerMethod = "boot" | "init" | "version" | "load" | "submit" | "reset" | "state" | "heap";

export interface WorkerRequest {
  id: number;
  method: WorkerMethod;
  args?: Record<string, unknown>;
}

export interface WorkerResponse {
  id: number;
  /** WebApi が返した JSON 文字列（boot だけは "ok"） */
  result?: string;
  /** Worker の中で起きた JS の例外（Java の例外は result の中の error で返る） */
  error?: string;
}
