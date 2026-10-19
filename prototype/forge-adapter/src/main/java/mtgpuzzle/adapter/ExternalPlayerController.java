package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

import forge.LobbyPlayer;
import forge.ai.ComputerUtil;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.SpellAbility;
import forge.game.trigger.WrappedAbility;
import forge.util.collect.FCollectionView;

/**
 * p1（パズルを解く人）のコントローラー。
 * 優先権・対象・攻撃宣言・任意の誘発は外部（UI）に問い合わせる。
 * それ以外の選択とマナ／コストの支払いは、PoC では親クラス（Forge AI）に任せ、呼ばれた事実を記録する。
 */
class ExternalPlayerController extends PlayerControllerAi {
    private final DecisionChannel channel;
    private final FallbackLog fallbackLog;

    ExternalPlayerController(Game game, Player p, LobbyPlayer lp, DecisionChannel channel, FallbackLog fallbackLog) {
        super(game, p, lp);
        this.channel = channel;
        this.fallbackLog = fallbackLog;
    }

    // ---------- 優先権 ----------

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        List<SpellAbility> playable = new ArrayList<>();
        List<Decision.Option> options = new ArrayList<>();
        options.add(new Decision.Option("pass", "Pass priority"));
        for (Card c : getGame().getCardsInGame()) {
            for (SpellAbility sa : c.getAllPossibleAbilities(player, true)) {
                if (sa.isManaAbility()) {
                    continue; // PoC ではマナは支払い時に自動で出す
                }
                playable.add(sa);
                options.add(new Decision.Option("a" + (playable.size() - 1), c.getName() + " | " + sa));
            }
        }
        List<String> answer = channel.ask(Decision.Kind.PRIORITY,
                getGame().getPhaseHandler().debugPrintState(true), options, 1, 1);
        String id = answer.get(0);
        if (id.equals("pass")) {
            return null;
        }
        return List.of(playable.get(Integer.parseInt(id.substring(1))));
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        if (sa.isLandAbility()) {
            if (sa.canPlay()) {
                sa.resolve();
            }
            return true;
        }
        // 対象は外部で選び、コスト（マナ含む）の支払いは AI のロジックで自動処理する
        ComputerUtil.handlePlayingSpellAbility(player, sa, this::chooseTargetsExternally);
        return true;
    }

    // ---------- 対象 ----------

    private void chooseTargetsExternally(SpellAbility root) {
        for (SpellAbility sa = root; sa != null; sa = sa.getSubAbility()) {
            if (!sa.usesTargeting()) {
                continue;
            }
            List<GameObject> candidates = new ArrayList<>();
            List<Decision.Option> options = new ArrayList<>();
            for (Player p : getGame().getPlayers()) {
                if (sa.canTarget(p)) {
                    candidates.add(p);
                    options.add(new Decision.Option("p" + p.getId(), "player:" + p.getName()));
                }
            }
            for (Card c : getGame().getCardsInGame()) {
                if (sa.canTarget(c)) {
                    candidates.add(c);
                    options.add(new Decision.Option("c" + c.getId(), c.getName() + " (" + c.getZone().getZoneType() + ", " + c.getController().getName() + ")"));
                }
            }
            int min = sa.getMinTargets();
            int max = Math.min(sa.getMaxTargets(), candidates.size());
            if (candidates.isEmpty()) {
                continue;
            }
            List<String> answer = channel.ask(Decision.Kind.TARGETS,
                    "Choose targets for " + sa.getHostCard().getName() + ": " + sa.getDescription(), options, min, max);
            for (String id : answer) {
                int idx = indexOf(options, id);
                sa.getTargets().add(candidates.get(idx));
            }
        }
    }

    private static int indexOf(List<Decision.Option> options, String id) {
        for (int i = 0; i < options.size(); i++) {
            if (options.get(i).id().equals(id)) {
                return i;
            }
        }
        throw new IllegalArgumentException("不明な選択肢: " + id);
    }

    @Override
    public boolean chooseTargetsFor(SpellAbility currentAbility) {
        chooseTargetsExternally(currentAbility);
        return currentAbility.isTargetNumberValid();
    }

    // ---------- 誘発 ----------

    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (activePlayerSAs.size() > 1) {
            fallbackLog.add(player, "orderSimultaneousSa(order=" + activePlayerSAs.size() + ")");
        }
        for (SpellAbility sa : activePlayerSAs) {
            if (sa.isTrigger() && !sa.isCopied()) {
                chooseTargetsExternally(sa);
                ComputerUtil.playStack(sa, player, getGame());
            } else {
                super.orderAndPlaySimultaneousSa(List.of(sa));
            }
        }
    }

    @Override
    public boolean confirmTrigger(WrappedAbility wrapper) {
        if (wrapper.isMandatory()) {
            return true;
        }
        List<String> answer = channel.ask(Decision.Kind.CONFIRM, "Use optional trigger? " + wrapper,
                List.of(new Decision.Option("yes", "Yes"), new Decision.Option("no", "No")), 1, 1);
        return answer.get(0).equals("yes");
    }

    // ---------- 戦闘 ----------

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        GameEntity defender = combat.getDefenders().stream().filter(d -> d instanceof Player).findFirst()
                .orElse(combat.getDefenders().getFirst());
        List<Card> able = new ArrayList<>();
        List<Decision.Option> options = new ArrayList<>();
        for (Card c : attacker.getCreaturesInPlay()) {
            if (CombatUtil.canAttack(c, defender)) {
                able.add(c);
                options.add(new Decision.Option("c" + c.getId(), c.getName()));
            }
        }
        if (able.isEmpty()) {
            return;
        }
        List<String> answer = channel.ask(Decision.Kind.ATTACKERS, "Declare attackers (defender: " + defender + ")",
                options, 0, able.size());
        for (String id : answer) {
            combat.addAttacker(able.get(indexOf(options, id)), defender);
        }
    }

    // ---------- AI に任せている選択（呼ばれたら記録） ----------

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal,
            SpellAbility sa, String title, boolean isOptional, Player targetedPlayer, Map<String, Object> params) {
        fallbackLog.add(player, "chooseSingleEntityForEffect: " + title);
        return super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params);
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title,
            int min, int max, boolean isOptional, Map<String, Object> params) {
        fallbackLog.add(player, "chooseCardsForEffect: " + title);
        return super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params);
    }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        fallbackLog.add(player, "chooseModeForAbility: " + sa);
        return super.chooseModeForAbility(sa, possible, min, num, allowRepeat);
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options,
            Card cardToShow, Map<String, Object> params) {
        fallbackLog.add(player, "confirmAction: " + message);
        return super.confirmAction(sa, mode, message, options, cardToShow, params);
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        fallbackLog.add(player, "chooseNumber: " + title);
        return super.chooseNumber(sa, title, min, max);
    }

    @Override
    public forge.game.spellability.TargetChoices chooseNewTargetsFor(SpellAbility ability, Predicate<GameObject> filter, boolean optional) {
        fallbackLog.add(player, "chooseNewTargetsFor: " + ability);
        return super.chooseNewTargetsFor(ability, filter, optional);
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        fallbackLog.add(player, "chooseCardsToDiscardToMaximumHandSize");
        return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
    }

    @Override
    public boolean isAI() {
        return false;
    }
}
