package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.cost.CostPartWithList;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.trigger.WrappedAbility;

/**
 * p1（パズルを解く人）のコントローラー。forge-ai には依存しない。
 * 優先権・対象・攻撃宣言・任意の誘発・マナ源・コストに使うカードを外部（UI）に問い合わせる。
 * それ以外の選択は BaseAdapterController の既定の答えを返し、FallbackLog に記録する。
 */
class ExternalPlayerController extends BaseAdapterController {
    private final DecisionChannel channel;
    /** 「自動で支払う」が選ばれた支払い（支払い対象の SpellAbility ごと） */
    private final Map<SpellAbility, Boolean> autoPay = new IdentityHashMap<>();

    ExternalPlayerController(Game game, Player p, LobbyPlayer lp, DecisionChannel channel, FallbackLog fallbackLog) {
        super(game, p, lp, fallbackLog);
        this.channel = channel;
    }

    private static int indexOf(List<Decision.Option> options, String id) {
        for (int i = 0; i < options.size(); i++) {
            if (options.get(i).id().equals(id)) {
                return i;
            }
        }
        throw new IllegalArgumentException("不明な選択肢: " + id);
    }

    private static String label(GameObject o) {
        if (o instanceof Player p) {
            return "player:" + p.getName();
        }
        Card c = (Card) o;
        return c.getName() + " (" + c.getZone().getZoneType() + ", " + c.getController().getName() + ")";
    }

    private static String id(GameObject o) {
        return o instanceof Player p ? "p" + p.getId() : "c" + ((Card) o).getId();
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
                    continue; // マナ能力は支払いのときに起動する
                }
                playable.add(sa);
                options.add(new Decision.Option("a" + (playable.size() - 1), c.getName() + " | " + sa));
            }
        }
        List<String> answer = channel.ask(Decision.Kind.PRIORITY,
                getGame().getPhaseHandler().debugPrintState(true), options, 1, 1);
        String id = answer.get(0);
        return id.equals("pass") ? null : List.of(playable.get(Integer.parseInt(id.substring(1))));
    }

    // ---------- 対象（SpellAbility.setupTargets から、対象を取る能力 1 つごとに呼ばれる） ----------

    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        List<GameObject> candidates = targetCandidates(sa);
        if (candidates.isEmpty()) {
            return sa.isTargetNumberValid();
        }
        List<Decision.Option> options = new ArrayList<>();
        for (GameObject o : candidates) {
            options.add(new Decision.Option(id(o), label(o)));
        }
        int min = sa.getMinTargets();
        int max = Math.min(sa.getMaxTargets(), candidates.size());
        List<String> answer = channel.ask(Decision.Kind.TARGETS,
                "Choose targets for " + sa.getHostCard().getName() + ": " + sa.getDescription(), options, min, max);
        for (String id : answer) {
            sa.getTargets().add(candidates.get(indexOf(options, id)));
        }
        return sa.isTargetNumberValid();
    }

    // ---------- 誘発 ----------

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

    // ---------- 支払い ----------

    @Override
    protected ManaPayer.Source chooseManaSource(SpellAbility saPaidFor, String remaining, List<ManaPayer.Source> sources) {
        if (autoPay.containsKey(saPaidFor)) {
            return sources.get(0);
        }
        List<Decision.Option> options = new ArrayList<>();
        options.add(new Decision.Option("auto", "Auto pay"));
        for (int i = 0; i < sources.size(); i++) {
            options.add(new Decision.Option("m" + i, sources.get(i).label()));
        }
        options.add(new Decision.Option("cancel", "Cancel"));
        String id = channel.ask(Decision.Kind.PAY_MANA, "Pay " + remaining + " for " + saPaidFor.getHostCard().getName(),
                options, 1, 1).get(0);
        if (id.equals("cancel")) {
            return null;
        }
        if (id.equals("auto")) {
            autoPay.put(saPaidFor, Boolean.TRUE);
            return sources.get(0);
        }
        return sources.get(Integer.parseInt(id.substring(1)));
    }

    @Override
    public CardCollectionView chooseCardsForCost(CardCollectionView optionList, SpellAbility sa, CostPartWithList cpl,
            int amount, boolean isOptional, String prompt) {
        List<Card> cards = new ArrayList<>();
        List<Decision.Option> options = new ArrayList<>();
        for (Card c : optionList) {
            cards.add(c);
            options.add(new Decision.Option("c" + c.getId(), label(c)));
        }
        List<String> answer = channel.ask(Decision.Kind.CHOOSE_CARDS, "Pay cost: " + prompt, options,
                isOptional ? 0 : amount, amount);
        CardCollection out = new CardCollection();
        for (String id : answer) {
            out.add(cards.get(indexOf(options, id)));
        }
        return out;
    }
}
