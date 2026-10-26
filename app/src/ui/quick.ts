// 手早く唱えるための操作（mtgtable の手札のドラッグに相当）。
// - カード（手札・戦場）を押すか、能力のメニューで項目を選ぶか、手札のカードをドラッグ・ダブルクリックすると、
//   唱える・起動するところから解決まで自動で進める（プレイヤー見出しの「スタックで止める」が ON のときは積んだところで止める）
// - 手札のカードを対象（盤面のカード・プレイヤー）の上へドラッグして離すと、その対象で唱える。
//   対象の要らない呪文は、盤面のどこかへ離せば唱える
// どちらも「おまかせ」（Macro）を始めるだけで、マナは自動で支払い、自分の呪文・能力（およびその誘発）がスタックに
// あるあいだは優先権を渡して解決まで進める。モード・X・2 つ目の対象など、人が決める選択が出たらそこで待ち、答えた後に続ける。

import type { Decision, GameView } from "../engine/protocol";

/** 進行中のおまかせ。cardId のカードの呪文・能力を、targetKey（あれば）を対象に唱えて解決する */
export interface Macro {
  cardId: string;
  targetKey: string | null;
  /** 唱える・起動する選択肢（メニューで選んだもの）。null なら、そのカードの呪文か、ただ 1 つの起動型能力 */
  optionId: string | null;
  /** targetKey を一度使ったか（2 つ目以降の対象は人が選ぶ） */
  targetUsed: boolean;
  /** 唱える・起動する選択肢を送ったか（取りやめで戻ってきたら、もう一度は唱えない） */
  started: boolean;
  /** 自分の呪文・能力をスタックで見て、優先権を渡したか */
  cast: boolean;
  steps: number;
}

export function startMacro(cardId: string, targetKey: string | null, optionId: string | null = null): Macro {
  return { cardId, targetKey, optionId, targetUsed: false, started: false, cast: false, steps: 0 };
}

/**
 * 今の選択要求に、おまかせで答える ID。人が決める選択なら null（待つ）。おまかせを終えるなら "end"。
 * holdStack が true（「スタックで止める」が ON）なら、スタックに積んだ後の優先権ではパスせず終える。
 * orderStack が true（「積む順を選ぶ」が ON）なら、同時誘発の順番選択（orderSimultaneous）は人が決める。
 * macro は更新する（targetUsed / cast / steps）
 */
export function macroAnswer(m: Macro, d: Decision, view: GameView, holdStack = false, orderStack = false): string[] | null | "end" {
  if (++m.steps > 1000) return "end";
  const onStack = view.stack.some((it) => it.sourceId === m.cardId);
  switch (d.kind) {
    case "PRIORITY": {
      if (!holdStack && (onStack || (m.cast && view.stack.length > 0))) {
        // 自分の呪文・能力（またはその誘発）がスタックにある: 優先権を渡して解決まで進める
        m.cast = true;
        return d.options.some((o) => o.id === "pass") ? ["pass"] : "end";
      }
      // 解決した・取りやめた・スタックで止める設定のとき: ここで終える
      if (m.started || m.cast || onStack) return "end";
      // まだ唱えていない: そのカードの呪文（無ければ、ただ 1 つの起動型能力）を選ぶ
      // マナ能力は数えない（マナは支払いのときに自動で出す）
      const opts = d.options.filter((o) => o.ref?.type === "ability" && o.ref.cardId === m.cardId && o.ref.abilityKind !== "mana");
      const pick = m.optionId
        ? opts.find((o) => o.id === m.optionId) ?? null
        : opts.find((o) => o.ref?.type === "ability" && o.ref.abilityKind === "spell") ?? (opts.length === 1 ? opts[0] : null);
      if (!pick) return "end"; // 唱えられない（または起動型能力が複数あって選べない）
      m.started = true;
      return [pick.id];
    }
    case "TARGETS": {
      if (m.targetKey && !m.targetUsed) {
        m.targetUsed = true;
        const o = d.options.find((x) => (x.ref?.type === "card" && x.ref.cardId === m.targetKey) || (x.ref?.type === "player" && x.ref.player === m.targetKey));
        if (o && d.min <= 1) return [o.id];
      }
      return null; // 人が選ぶ
    }
    case "PAY_MANA":
      return d.options.some((o) => o.id === "auto") ? ["auto"] : null;
    case "CHOOSE_MODE":
      if (!orderStack && d.promptKey === "orderSimultaneous" && d.options.length > 0) return [d.options[0].id];
      return null;
    default:
      return null; // モード・X・コストのカード・確認などは人が決める
  }
}
