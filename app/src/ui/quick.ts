// 手早く唱えるための操作（mtgtable の手札のドラッグに相当）。
// - 手札のカードを対象（盤面のカード・プレイヤー）の上へドラッグして離すと、その対象で唱える。
//   対象の要らない呪文は、盤面のどこかへ離せば唱える
// - 使えるカード（手札・戦場）をダブルクリックすると、唱える・起動するところから解決まで進める
// どちらも「おまかせ」（Macro）を始めるだけで、マナは自動で支払い、自分の呪文・能力がスタックの一番上に
// 来たら優先権を渡して解決する。モード・X・2 つ目の対象など、人が決める選択が出たらそこで待ち、答えた後に続ける。

import type { Decision, GameView } from "../engine/protocol";

/** 進行中のおまかせ。cardId のカードの呪文・能力を、targetKey（あれば）を対象に唱えて解決する */
export interface Macro {
  cardId: string;
  targetKey: string | null;
  /** targetKey を一度使ったか（2 つ目以降の対象は人が選ぶ） */
  targetUsed: boolean;
  /** 唱える・起動する選択肢を送ったか（取りやめで戻ってきたら、もう一度は唱えない） */
  started: boolean;
  /** 自分の呪文・能力をスタックの一番上で見て、優先権を渡したか */
  cast: boolean;
  steps: number;
}

export function startMacro(cardId: string, targetKey: string | null): Macro {
  return { cardId, targetKey, targetUsed: false, started: false, cast: false, steps: 0 };
}

/**
 * 今の選択要求に、おまかせで答える ID。人が決める選択なら null（待つ）。おまかせを終えるなら "end"。
 * macro は更新する（targetUsed / cast / steps）
 */
export function macroAnswer(m: Macro, d: Decision, view: GameView): string[] | null | "end" {
  if (++m.steps > 30) return "end";
  const onStack = view.stack.some((it) => it.sourceId === m.cardId);
  const top = view.stack[0];
  switch (d.kind) {
    case "PRIORITY": {
      if (top && top.sourceId === m.cardId) {
        // 自分の呪文・能力が一番上: 優先権を渡して解決する
        m.cast = true;
        return d.options.some((o) => o.id === "pass") ? ["pass"] : "end";
      }
      // 解決した・取りやめた・ほかの物が一番上に来た（誘発など）: ここから先は人が進める
      if (m.started || m.cast || onStack) return "end";
      // まだ唱えていない: そのカードの呪文（無ければ、ただ 1 つの起動型能力）を選ぶ
      const opts = d.options.filter((o) => o.ref?.type === "ability" && o.ref.cardId === m.cardId);
      const pick = opts.find((o) => o.ref?.type === "ability" && o.ref.abilityKind === "spell") ?? (opts.length === 1 ? opts[0] : null);
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
    default:
      return null; // モード・X・コストのカード・確認などは人が決める
  }
}
