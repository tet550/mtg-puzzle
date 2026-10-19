package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;

import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.keyword.Keyword;
import forge.game.player.Player;

/**
 * 相手（p2）のブロックを決める（forge-ai は使わない）。
 * パズルは「相手がどうブロックしても勝てる」ことを求めるので、相手は受けるダメージが最も少なくなるブロックを選ぶ。
 * ブロックの割り当てをすべて試し（多すぎれば打ち切って貪欲に決める）、次の順に比べる。
 * 1. 相手が受ける戦闘ダメージが少ない（トランプルは、ブロッカーの致死ダメージを超えた分が通る）
 * 2. 相手が失うクリーチャーが少ない
 * 3. 倒せる攻撃クリーチャーが多い
 * ルール上できない割り当て（威迫・ブロックの最小数など）は CombatUtil.validateBlocks で除く。
 * 先制攻撃・接死・絆魂・感染などは数えない（目安。完全な読み切りではない）。
 */
final class BlockPlanner {
    /** 試す割り当ての上限（ブロッカー数と攻撃クリーチャー数の組み合わせ） */
    private static final int MAX_ASSIGNMENTS = 20_000;

    private BlockPlanner() { }

    private record Score(int damage, int lostBlockers, int killedAttackers) {
        boolean betterThan(Score o) {
            if (o == null) return true;
            if (damage != o.damage) return damage < o.damage;
            if (lostBlockers != o.lostBlockers) return lostBlockers < o.lostBlockers;
            return killedAttackers > o.killedAttackers;
        }
    }

    static void declare(Player defender, Combat combat) {
        List<Card> attackers = new ArrayList<>();
        combat.getAttackersOf(defender).forEach(attackers::add);
        if (attackers.isEmpty()) {
            return;
        }
        List<Card> blockers = new ArrayList<>();
        for (Card c : defender.getCreaturesInPlay()) {
            if (CombatUtil.canBlock(c, combat)) {
                blockers.add(c);
            }
        }
        if (blockers.isEmpty()) {
            return;
        }
        // ブロッカーごとに、ブロックできる攻撃クリーチャー（-1 はブロックしない）
        List<int[]> choices = new ArrayList<>();
        long combos = 1;
        for (Card b : blockers) {
            List<Integer> can = new ArrayList<>();
            can.add(-1);
            for (int i = 0; i < attackers.size(); i++) {
                if (CombatUtil.canBlock(attackers.get(i), b, combat)) {
                    can.add(i);
                }
            }
            choices.add(can.stream().mapToInt(Integer::intValue).toArray());
            combos *= can.size();
        }
        int[] best = combos <= MAX_ASSIGNMENTS ? search(defender, combat, attackers, blockers, choices) : greedy(attackers, blockers, choices);
        apply(combat, attackers, blockers, best);
        if (CombatUtil.validateBlocks(combat, defender) != null) {
            undo(combat, blockers); // 貪欲に決めた割り当てがルールに合わない（威迫など）ときはブロックしない
        }
    }

    private static int[] search(Player defender, Combat combat, List<Card> attackers, List<Card> blockers, List<int[]> choices) {
        int n = blockers.size();
        int[] cur = new int[n];
        int[] idx = new int[n];
        int[] best = new int[n];
        java.util.Arrays.fill(best, -1);
        Score bestScore = null;
        while (true) {
            for (int i = 0; i < n; i++) {
                cur[i] = choices.get(i)[idx[i]];
            }
            apply(combat, attackers, blockers, cur);
            if (CombatUtil.validateBlocks(combat, defender) == null) {
                Score s = score(attackers, blockers, cur);
                if (s.betterThan(bestScore)) {
                    bestScore = s;
                    best = cur.clone();
                }
            }
            undo(combat, blockers);
            // 次の組み合わせ（桁上がり）
            int k = 0;
            while (k < n && ++idx[k] >= choices.get(k).length) {
                idx[k] = 0;
                k++;
            }
            if (k == n) {
                break;
            }
        }
        return best;
    }

    /** 組み合わせが多すぎるとき: パワーの大きい攻撃クリーチャーから、ブロックできるブロッカーを 1 体ずつ当てる */
    private static int[] greedy(List<Card> attackers, List<Card> blockers, List<int[]> choices) {
        int[] out = new int[blockers.size()];
        java.util.Arrays.fill(out, -1);
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < attackers.size(); i++) {
            order.add(i);
        }
        order.sort((a, b) -> Integer.compare(attackers.get(b).getNetCombatDamage(), attackers.get(a).getNetCombatDamage()));
        boolean[] used = new boolean[blockers.size()];
        for (int a : order) {
            for (int j = 0; j < blockers.size(); j++) {
                if (!used[j] && contains(choices.get(j), a)) {
                    out[j] = a;
                    used[j] = true;
                    break;
                }
            }
        }
        return out;
    }

    private static boolean contains(int[] xs, int v) {
        for (int x : xs) {
            if (x == v) return true;
        }
        return false;
    }

    private static Score score(List<Card> attackers, List<Card> blockers, int[] assign) {
        int damage = 0, lost = 0, killed = 0;
        for (int a = 0; a < attackers.size(); a++) {
            Card att = attackers.get(a);
            int power = Math.max(0, att.getNetCombatDamage());
            List<Card> bs = new ArrayList<>();
            for (int j = 0; j < blockers.size(); j++) {
                if (assign[j] == a) bs.add(blockers.get(j));
            }
            if (bs.isEmpty()) {
                damage += power;
                continue;
            }
            // 攻撃側は致死ダメージを順に割り振る。トランプルなら余りが相手に通る
            int left = power;
            for (Card b : bs) {
                int lethal = Math.max(1, b.getLethalDamage());
                if (left >= lethal) {
                    lost++;
                    left -= lethal;
                } else {
                    left = 0;
                }
            }
            if (att.hasKeyword(Keyword.TRAMPLE)) {
                damage += left;
            }
            int blockPower = bs.stream().mapToInt(b -> Math.max(0, b.getNetCombatDamage())).sum();
            if (blockPower >= Math.max(1, att.getLethalDamage())) {
                killed++;
            }
        }
        return new Score(damage, lost, killed);
    }

    private static void apply(Combat combat, List<Card> attackers, List<Card> blockers, int[] assign) {
        for (int j = 0; j < blockers.size(); j++) {
            if (assign[j] >= 0) {
                combat.addBlocker(attackers.get(assign[j]), blockers.get(j));
            }
        }
    }

    private static void undo(Combat combat, List<Card> blockers) {
        for (Card b : blockers) {
            combat.undoBlockingAssignment(b);
        }
    }
}
