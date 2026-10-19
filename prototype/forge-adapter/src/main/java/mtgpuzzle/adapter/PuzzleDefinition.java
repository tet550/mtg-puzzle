package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 問題データ（要件 6 章の JSON）の Java 側表現。PoC 用の最小サブセット。
 * cardId は暫定的に Forge のカード名をそのまま使う（カード ID との対応表は別途定義）。
 */
public class PuzzleDefinition {
    public int schemaVersion;
    public String title;
    public String description;
    public GameDef game;
    public Goal goal;
    public Opponent opponent;

        public static class GameDef {
        public String activePlayer = "p1";
        public String phase = "main1";
        public int turn = 1;
        public List<PlayerDef> players = new ArrayList<>();
    }

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

        public static class CardDef {
        public String id;
        public String cardId;
        public boolean tapped;
        public boolean summoningSick;
        /** 例: {"P1P1": 2} */
        public Map<String, Integer> counters = new LinkedHashMap<>();
    }

        public static class Goal {
        public String type = "win";
        public String player = "p1";
        public String deadline = "current_turn";
    }

        public static class Opponent {
        public String policy = "pass";
        /** ブロックの方針: minimize（受けるダメージが最も少なくなるようにブロックする。既定）/ none（ブロックしない） */
        public String block = "minimize";
    }

    // ---------------- JSON から読む（Jackson を使わない） ----------------

    public static PuzzleDefinition fromJson(String json) {
        Map<String, Object> m = Json.parseObject(json);
        PuzzleDefinition p = new PuzzleDefinition();
        p.schemaVersion = (int) num(m, "schemaVersion", 0);
        p.title = str(m, "title", null);
        p.description = str(m, "description", null);
        Map<String, Object> g = obj(m, "game");
        if (g != null) {
            p.game = new GameDef();
            p.game.activePlayer = str(g, "activePlayer", p.game.activePlayer);
            p.game.phase = str(g, "phase", p.game.phase);
            p.game.turn = (int) num(g, "turn", p.game.turn);
            for (Map<String, Object> pm : objs(g, "players")) {
                PlayerDef pd = new PlayerDef();
                pd.id = str(pm, "id", null);
                pd.life = (int) num(pm, "life", pd.life);
                pd.hand = cards(pm, "hand");
                pd.battlefield = cards(pm, "battlefield");
                pd.graveyard = cards(pm, "graveyard");
                pd.exile = cards(pm, "exile");
                pd.library = cards(pm, "library");
                pd.manaPool = str(pm, "manaPool", null);
                p.game.players.add(pd);
            }
        }
        Map<String, Object> goal = obj(m, "goal");
        if (goal != null) {
            p.goal = new Goal();
            p.goal.type = str(goal, "type", p.goal.type);
            p.goal.player = str(goal, "player", p.goal.player);
            p.goal.deadline = str(goal, "deadline", p.goal.deadline);
        }
        Map<String, Object> opp = obj(m, "opponent");
        if (opp != null) {
            p.opponent = new Opponent();
            p.opponent.policy = str(opp, "policy", p.opponent.policy);
            p.opponent.block = str(opp, "block", p.opponent.block);
        }
        return p;
    }

    private static List<CardDef> cards(Map<String, Object> m, String key) {
        List<CardDef> out = new ArrayList<>();
        for (Map<String, Object> cm : objs(m, key)) {
            CardDef c = new CardDef();
            c.id = str(cm, "id", null);
            c.cardId = str(cm, "cardId", null);
            c.tapped = Boolean.TRUE.equals(cm.get("tapped"));
            c.summoningSick = Boolean.TRUE.equals(cm.get("summoningSick"));
            Map<String, Object> counters = obj(cm, "counters");
            if (counters != null) {
                counters.forEach((k, v) -> c.counters.put(k, ((Number) v).intValue()));
            }
            out.add(c);
        }
        return out;
    }

    private static String str(Map<String, Object> m, String key, String def) {
        Object v = m.get(key);
        return v == null ? def : v.toString();
    }

    private static double num(Map<String, Object> m, String key, double def) {
        Object v = m.get(key);
        return v instanceof Number n ? n.doubleValue() : def;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> obj(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> objs(Map<String, Object> m, String key) {
        Object v = m.get(key);
        List<Map<String, Object>> out = new ArrayList<>();
        if (v instanceof List<?> list) {
            for (Object o : list) {
                out.add((Map<String, Object>) o);
            }
        }
        return out;
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
            // 問題の初期盤面は「すでに戦場にある」状態なので、戦場に出たときの誘発を起こさない
            lines.add(k + "battlefield=" + p.battlefield.stream().map(c -> card(c) + "|NoETBTrigs").collect(Collectors.joining(";")));
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
