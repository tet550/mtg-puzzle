package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * 問題データ（要件 6 章の JSON）の Java 側表現。PoC 用の最小サブセット。
 * cardId は暫定的に Forge のカード名をそのまま使う（カード ID との対応表は別途定義）。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class PuzzleDefinition {
    public int schemaVersion;
    public String title;
    public String description;
    public GameDef game;
    public Goal goal;
    public Opponent opponent;

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class GameDef {
        public String activePlayer = "p1";
        public String phase = "main1";
        public int turn = 1;
        public List<PlayerDef> players = new ArrayList<>();
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class PlayerDef {
        public String id;
        public int life = 20;
        public List<CardDef> hand = new ArrayList<>();
        public List<CardDef> battlefield = new ArrayList<>();
        public List<CardDef> graveyard = new ArrayList<>();
        public List<CardDef> exile = new ArrayList<>();
        public List<CardDef> library = new ArrayList<>();
        /** 例: "R R G" */
        public String manaPool;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class CardDef {
        public String id;
        public String cardId;
        public boolean tapped;
        public boolean summoningSick;
        /** 例: {"P1P1": 2} */
        public Map<String, Integer> counters = new LinkedHashMap<>();
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Goal {
        public String type = "win";
        public String player = "p1";
        public String deadline = "current_turn";
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Opponent {
        public String policy = "pass";
    }

    /** Forge の GameState の key 接頭辞。index 0 = human, 1 = ai */
    static String forgeKey(int playerIndex) {
        return playerIndex == 0 ? "human" : "ai";
    }

    int playerIndex(String playerId) {
        for (int i = 0; i < game.players.size(); i++) {
            if (game.players.get(i).id.equals(playerId)) {
                return i;
            }
        }
        throw new PuzzleValidationException("存在しないプレイヤー: " + playerId);
    }

    /** Forge GameState のテキスト形式に変換する */
    public List<String> toGameStateLines() {
        List<String> lines = new ArrayList<>();
        lines.add("turn=" + game.turn);
        lines.add("activeplayer=" + forgeKey(playerIndex(game.activePlayer)));
        lines.add("activephase=" + game.phase.toUpperCase());
        for (int i = 0; i < game.players.size(); i++) {
            PlayerDef p = game.players.get(i);
            String k = forgeKey(i);
            lines.add(k + "life=" + p.life);
            lines.add(k + "hand=" + zone(p.hand));
            lines.add(k + "battlefield=" + zone(p.battlefield));
            lines.add(k + "graveyard=" + zone(p.graveyard));
            lines.add(k + "exile=" + zone(p.exile));
            lines.add(k + "library=" + zone(p.library));
            if (p.manaPool != null && !p.manaPool.isBlank()) {
                lines.add(k + "manapool=" + p.manaPool);
            }
        }
        return lines;
    }

    private static String zone(List<CardDef> cards) {
        return cards.stream().map(PuzzleDefinition::card).collect(Collectors.joining(";"));
    }

    private static String card(CardDef c) {
        StringBuilder sb = new StringBuilder(c.cardId);
        if (c.tapped) sb.append("|Tapped");
        if (c.summoningSick) sb.append("|SummonSick");
        if (!c.counters.isEmpty()) {
            sb.append("|Counters:").append(c.counters.entrySet().stream()
                    .map(e -> e.getKey() + "=" + e.getValue()).collect(Collectors.joining(",")));
        }
        return sb.toString();
    }
}
