package mtgpuzzle.adapter;

import java.io.File;
import java.lang.reflect.Field;
import java.util.function.Supplier;

import forge.util.CardTranslation;

/**
 * Forge の日本語の訳（CardTranslation、res/languages/cardnames-ja-JP.txt）を使って、選択肢などの日本語の文を作る
 * （design/option-i18n.md の方式 A）。
 *
 * Forge の訳の言語は static な 1 つの値で、ゲームでカードを作るとき（盤面の復元）にその言語が日本語なら
 * 「英語のオラクルの行 ↔ 日本語の文の行」の対応表を作る。資源を読み直すと対応表が消えるので、
 * 言語は CardTranslation.languageSelected を直接切り替える。ふだんは英語（ログ・テストの文を変えない）で、
 * 盤面の復元の間と、日本語の文を作る間だけ日本語にする。
 */
final class Ja {
    private static Field language;

    private Ja() { }

    /** 日本語の訳を読み込む（res/languages/cardnames-ja-JP.txt が無ければ何もしない。日本語の文は null になる） */
    static synchronized void init(String languagesDir) {
        if (language != null || !new File(languagesDir, "cardnames-ja-JP.txt").exists()) {
            return;
        }
        try {
            CardTranslation.preloadTranslation("ja-JP", languagesDir);
            Field f = CardTranslation.class.getDeclaredField("languageSelected");
            f.setAccessible(true);
            f.set(null, "en-US");
            language = f;
        } catch (ReflectiveOperationException | RuntimeException e) {
            System.err.println("日本語の訳を使えません: " + e);
            CardTranslation.preloadTranslation("en-US", languagesDir);
        }
    }

    static boolean available() {
        return language != null;
    }

    /**
     * 日本語の訳を有効にして s を呼ぶ（訳が無ければ null）。
     * ロックは掛けない: ゲームスレッドと呼び出し側は交互にしか動かない（DecisionChannel）。盤面の復元の途中で
     * 問い合わせが起きたときに、ロックを持ったまま待つと、呼び出し側の getState と互いに待ち合ってしまう
     */
    static <T> T with(Supplier<T> s) {
        if (language == null) {
            return null;
        }
        try {
            Object prev = language.get(null);
            language.set(null, "ja-JP");
            try {
                return s.get();
            } finally {
                language.set(null, prev);
            }
        } catch (IllegalAccessException e) {
            return null;
        }
    }

    /** 日本語の訳を有効にして r を実行する（盤面の復元。カードを作るときに対応表ができる） */
    static void run(Runnable r) {
        if (language == null) {
            r.run();
            return;
        }
        with(() -> {
            r.run();
            return null;
        });
    }

    /** 日本語のカード名（訳が無ければ英語のまま） */
    static String name(String english) {
        String n = with(() -> CardTranslation.getTranslatedName(english));
        return n == null || n.isEmpty() ? english : n;
    }

    /** Forge の説明文（CARDNAME を含む）を日本語にする。訳せなければ英語のまま（CARDNAME は日本語の名前に） */
    static String description(String english, forge.game.card.Card host) {
        if (english == null || host == null) {
            return english;
        }
        String t = with(() -> CardTranslation.translateMultipleDescriptionText(english, host));
        return (t == null ? english : t).replace("CARDNAME", name(host.getName()));
    }

    /**
     * スタックの項目の日本語の文: 呪文・能力のうち、実際に解決する部分（選んだモード・追加の効果）の説明を、
     * それぞれ訳してつなぐ（モードの一覧を持つ親の説明は除く）。訳が無ければ null
     */
    static String stackDescription(forge.game.spellability.SpellAbility sa) {
        if (language == null || sa == null) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (forge.game.spellability.SpellAbility n = sa; n != null; n = n.getSubAbility()) {
            if (n.getApi() == forge.game.ability.ApiType.Charm) {
                continue;
            }
            String d = n.getDescription();
            if (d == null || d.isBlank() || n.getHostCard() == null) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(description(d, n.getHostCard()).replaceFirst("^[・•]\\s*", "").trim());
        }
        return sb.length() == 0 ? null : sb.toString();
    }
}
