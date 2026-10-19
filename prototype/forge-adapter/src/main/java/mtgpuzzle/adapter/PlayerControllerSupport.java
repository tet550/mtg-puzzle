package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollectionView;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

/**
 * BaseAdapterController（自動生成）が使う共通処理。
 */
abstract class PlayerControllerSupport extends PlayerController {
    protected final FallbackLog fallbackLog;

    PlayerControllerSupport(Game game, Player p, LobbyPlayer lp, FallbackLog fallbackLog) {
        super(game, p, lp);
        this.fallbackLog = fallbackLog;
    }

    /** 外部入力に置き換えていない選択に、既定の答えを返したことを記録する */
    protected void fallback(String what) {
        fallbackLog.add(player, what);
    }

    protected static <T> List<T> firstN(Iterable<T> items, int n) {
        List<T> out = new ArrayList<>();
        if (items == null) {
            return out;
        }
        for (T t : items) {
            if (out.size() >= n) {
                break;
            }
            out.add(t);
        }
        return out;
    }

    /** 同時に誘発した能力をスタックに置く（人間用の PlayerControllerHuman と同じ手順） */
    protected void playSimultaneous(SpellAbility next) {
        if (next.isTrigger() && !next.isCopied()) {
            PlaySpellAbility.playSpellAbility(this, player, next);
            return;
        }
        if (next.isCopied()) {
            if (next.isSpell()) {
                if (!next.getHostCard().isInZone(ZoneType.Stack)) {
                    next.setHostCard(player.getGame().getAction().moveToStack(next.getHostCard(), next));
                } else {
                    player.getGame().getStackZone().add(next.getHostCard());
                }
            }
            if (next.isMayChooseNewTargets()) {
                next.setupNewTargets(player);
            }
        }
        player.getGame().getStack().add(next);
    }

    /**
     * 戦闘ダメージの割り振りに、選ぶ余地があるか（forge-gui の PlayerControllerHuman と同じ判定）。
     * ブロッカーが 2 体以上か、トランプルで防御側にも割り振れるときだけ選ぶ余地がある
     */
    protected static boolean damageAssignmentIsChoice(Card attacker, CardCollectionView blockers, GameEntity defender) {
        return blockers.size() > 1 || (attacker.hasKeyword(forge.game.keyword.Keyword.TRAMPLE) && defender != null && !blockers.isEmpty());
    }

    /** 選ぶ余地が無い割り振り: ブロッカー（いなければ防御側）にすべて */
    protected static Map<Card, Integer> trivialDamageAssignment(CardCollectionView blockers, int damageDealt) {
        Map<Card, Integer> map = new HashMap<>();
        map.put(blockers.isEmpty() ? null : blockers.getFirst(), damageDealt);
        return map;
    }

    /** 戦闘ダメージの割り振り: ブロッカーに順に致死量を割り振り、残りを防御側へ（トランプル時） */
    protected Map<Card, Integer> defaultDamageAssignment(Card attacker, CardCollectionView blockers, CardCollectionView remaining,
            int damageDealt, GameEntity defender, boolean overrideOrder) {
        Map<Card, Integer> map = new HashMap<>();
        int left = damageDealt;
        for (Card b : blockers) {
            int lethal = Math.max(0, b.getLethalDamage());
            int d = Math.min(left, Math.max(lethal, 1));
            if (d > 0) {
                map.put(b, d);
                left -= d;
            }
        }
        if (left > 0) {
            if (!blockers.isEmpty() && (defender == null || !attacker.hasKeyword(forge.game.keyword.Keyword.TRAMPLE))) {
                Card last = blockers.getLast();
                map.merge(last, left, Integer::sum);
            } else {
                map.put(null, left); // null は防御側プレイヤー／プレインズウォーカー
            }
        }
        return map;
    }

    /**
     * パワーの合計が need 以上になるようにタップするクリーチャーを選ぶ（搭乗など）。
     * 既定はパワーの大きい順に、足りるまで選ぶ。外部コントローラーは UI に問い合わせる
     */
    protected forge.game.card.CardCollectionView chooseCardsForTotalPower(forge.game.card.CardCollectionView candidates, SpellAbility sa,
            forge.game.cost.CostPartWithList cost, int need) {
        List<Card> sorted = new ArrayList<>();
        candidates.forEach(sorted::add);
        sorted.sort((a, b) -> Integer.compare(b.getNetPower(), a.getNetPower()));
        forge.game.card.CardCollection out = new forge.game.card.CardCollection();
        int sum = 0;
        for (Card c : sorted) {
            if (sum >= need) {
                break;
            }
            out.add(c);
            sum += c.getNetPower();
        }
        return out;
    }

    /** マナ源を選ぶ。既定は先頭（自動支払い）。外部コントローラーは UI に問い合わせる */
    protected ManaPayer.Source chooseManaSource(SpellAbility saPaidFor, String remaining, List<ManaPayer.Source> sources) {
        return sources.get(0);
    }

    /** 1 つの能力について、対象の候補（プレイヤーとカード） */
    protected static List<GameObject> targetCandidates(SpellAbility sa) {
        List<GameObject> out = new ArrayList<>();
        for (Player p : sa.getHostCard().getGame().getPlayers()) {
            if (sa.canTarget(p)) {
                out.add(p);
            }
        }
        for (Card c : sa.getHostCard().getGame().getCardsInGame()) {
            if (sa.canTarget(c)) {
                out.add(c);
            }
        }
        return out;
    }
}
