package mtgpuzzle.adapter;

import java.util.List;
import java.util.Map;

/**
 * Forge が p1 に求めている選択。UI はこれを表示し、options の id で回答する。
 * prompt は英語の説明。promptKey があれば、UI は promptKey と promptArgs から画面の言語の文を作る
 * （Forge が作った説明は promptKey が null で、英語のまま）。
 */
public record Decision(int seq, Kind kind, String prompt, List<Option> options, int min, int max,
                       String promptKey, Map<String, String> promptArgs) {

    public Decision(int seq, Kind kind, String prompt, List<Option> options, int min, int max) {
        this(seq, kind, prompt, options, min, max, null, Map.of());
    }

    public enum Kind {
        /** 優先権: 唱える・起動する・土地を置く、またはパス */
        PRIORITY,
        /** 対象の選択 */
        TARGETS,
        /** 攻撃クリーチャーの宣言 */
        ATTACKERS,
        /** はい／いいえ（任意の誘発、任意の処理の確認など） */
        CONFIRM,
        /** マナの支払い: 起動するマナ源を 1 つ選ぶ（"auto" で残りを自動、"cancel" で取りやめ） */
        PAY_MANA,
        /** コストに使うカードを選ぶ（生け贄・捨てる・タップなど） */
        CHOOSE_CARDS,
        /** 効果で選ぶ（カード・プレイヤー。対象を取らない選択） */
        CHOOSE_ENTITY,
        /** モードを選ぶ */
        CHOOSE_MODE,
        /** 数を選ぶ（X の値など）。選択肢は値ごとに 1 つ */
        CHOOSE_NUMBER
    }

    /**
     * ref は UI が盤面の要素と結び付けるための参照（無ければ null）。Forge の内部 ID のまま持ち、WebApi でインスタンス ID に直す。
     * labelJa は日本語の文（Forge の訳。訳せない・訳が無ければ null）
     */
    public record Option(String id, String label, Ref ref, String labelJa) {
        public Option(String id, String label) {
            this(id, label, null, null);
        }

        public Option(String id, String label, Ref ref) {
            this(id, label, ref, null);
        }
    }

    /** 説明: 英語の文と、UI が画面の言語で文にするための種類（key）と値（args） */
    public record Prompt(String text, String key, Map<String, String> args) {
        static Prompt of(String text, String key, String... kv) {
            Map<String, String> m = new java.util.LinkedHashMap<>();
            for (int i = 0; i + 1 < kv.length; i += 2) {
                if (kv[i + 1] != null) {
                    m.put(kv[i], kv[i + 1]);
                }
            }
            return new Prompt(text, key, m);
        }

        static Prompt text(String text) {
            return new Prompt(text, null, Map.of());
        }
    }

    /**
     * 選択肢が指すもの。
     * type: card（forgeId）/ player（player）/ ability（forgeId のカードの能力。abilityKind は spell / activated / mana / land）
     *       / stack（stackIndex。0 が一番上）/ special（pass / auto / cancel / yes / no）
     */
    public record Ref(String type, int forgeId, String player, String abilityKind, int stackIndex, String special) {
        static Ref card(int forgeId) {
            return new Ref("card", forgeId, null, null, -1, null);
        }

        static Ref player(String player) {
            return new Ref("player", -1, player, null, -1, null);
        }

        static Ref ability(int forgeId, String abilityKind) {
            return new Ref("ability", forgeId, null, abilityKind, -1, null);
        }

        static Ref stack(int stackIndex) {
            return new Ref("stack", -1, null, null, stackIndex, null);
        }

        static Ref special(String value) {
            return new Ref("special", -1, null, null, -1, value);
        }
    }

    public Option findByLabelPrefix(String prefix) {
        return options.stream().filter(o -> o.label().startsWith(prefix)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("選択肢がありません: " + prefix + " in " + options));
    }
}
