package mtgpuzzle.adapter;

import java.util.List;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameObject;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;

/**
 * 相手（p2）のコントローラー。要件 4.3: 任意の呪文・能力は使わず、常に優先権をパスする。攻撃・ブロックもしない。
 * 強制選択には BaseAdapterController の既定の答え（先頭から最小数を選ぶ）を返し、FallbackLog に記録する。
 * これが「問題で定めた方針」の既定値になる。forge-ai には依存しない。
 */
class PassingPlayerController extends BaseAdapterController {

    private final DecisionChannel channel;

    PassingPlayerController(Game game, Player p, LobbyPlayer lp, DecisionChannel channel, FallbackLog fallbackLog) {
        super(game, p, lp, fallbackLog);
        this.channel = channel;
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        channel.checkHalt();
        return null;
    }

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        // 攻撃しない
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        // ブロックしない
    }

    /** 相手の強制的な対象選択（例: 相手がコントロールする誘発能力）は、候補の先頭から必要数を選ぶ */
    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        List<GameObject> candidates = targetCandidates(sa);
        fallback("chooseTargetsFor: " + sa);
        for (GameObject o : firstN(candidates, sa.getMinTargets())) {
            sa.getTargets().add(o);
        }
        return sa.isTargetNumberValid();
    }
}
