package mtgpuzzle.adapter;

import java.util.List;

/**
 * Forge が p1 に求めている選択。UI はこれを表示し、options の id で回答する。
 */
public record Decision(int seq, Kind kind, String prompt, List<Option> options, int min, int max) {

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

    /** ref は UI が盤面の要素と結び付けるための参照（無ければ null）。Forge の内部 ID のまま持ち、WebApi でインスタンス ID に直す */
    public record Option(String id, String label, Ref ref) {
        public Option(String id, String label) {
            this(id, label, null);
        }
    }

    /**
     * 選択肢が指すもの。
     * type: card（forgeId）/ player（player）/ ability（forgeId のカードの能力。abilityKind は spell / activated / land）
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
