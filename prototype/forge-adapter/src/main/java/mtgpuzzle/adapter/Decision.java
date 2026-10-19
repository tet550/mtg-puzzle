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
        /** はい／いいえ（任意の誘発など） */
        CONFIRM,
        /** マナの支払い: 起動するマナ源を 1 つ選ぶ（"auto" で残りを自動、"cancel" で取りやめ） */
        PAY_MANA,
        /** コストに使うカードを選ぶ（生け贄・捨てる・タップなど） */
        CHOOSE_CARDS
    }

    public record Option(String id, String label) { }

    public Option findByLabelPrefix(String prefix) {
        return options.stream().filter(o -> o.label().startsWith(prefix)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("選択肢がありません: " + prefix + " in " + options));
    }
}
