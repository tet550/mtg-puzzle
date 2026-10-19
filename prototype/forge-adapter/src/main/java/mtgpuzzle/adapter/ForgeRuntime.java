package mtgpuzzle.adapter;

import java.io.File;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import forge.CardStorageReader;
import forge.ImageKeys;
import forge.StaticData;
import forge.ai.AiProfileUtil;
import forge.card.CardType;
import forge.game.card.CardUtil;
import forge.util.FileSection;
import forge.util.FileUtil;
import forge.util.Lang;
import forge.util.Localizer;

/**
 * forge-gui の FModel を使わずに、ルール処理に必要な静的データだけを初期化する。
 */
public final class ForgeRuntime {
    private static boolean initialized;
    private static long initMillis;

    private ForgeRuntime() { }

    /**
     * @param resDir       Forge の res ディレクトリ
     * @param lazyCards    true なら cardsfolder を全件読まず、名前で参照されたカードだけを読み込む
     */
    public static synchronized void init(String resDir, boolean lazyCards) {
        if (initialized) {
            return;
        }
        long start = System.currentTimeMillis();
        String res = resDir.endsWith(File.separator) ? resDir : resDir + File.separator;
        try {
            // カード生成時に画像キーを計算するため、画像キャッシュのディレクトリ設定が必須（実際には読まない）
            String noImages = Files.createTempDirectory("forge-noimg").toString() + File.separator;
            ImageKeys.initializeDirs(noImages, new HashMap<>(), noImages, noImages, noImages, noImages, noImages, noImages, noImages);

            Lang.createInstance("en-US");
            Localizer.getInstance().initialize("en-US", res + "languages" + File.separator);

            CardStorageReader cardReader = new CardStorageReader(res + "cardsfolder", null, lazyCards);
            CardStorageReader tokenReader = new CardStorageReader(res + "tokenscripts", null, false);
            String emptyDir = Files.createTempDirectory("forge-empty").toString();
            new StaticData(cardReader, tokenReader, null, null,
                    res + "editions", emptyDir, res + "blockdata", res + "setlookup",
                    "LATEST_ART_ALL_EDITIONS", true, true, false, false);

            AiProfileUtil.loadAllProfiles(res + "ai");
            loadDynamicGamedata(res);
        } catch (Exception e) {
            throw new IllegalStateException("Forge の初期化に失敗しました", e);
        }
        initMillis = System.currentTimeMillis() - start;
        initialized = true;
    }

    /**
     * FModel.loadDynamicGamedata() と同じ処理。
     * TypeLists.txt を読まないと基本土地タイプが認識されず、Mountain などがマナ能力を持たない（エラーにもならない）。
     */
    private static void loadDynamicGamedata(String res) {
        if (!CardType.Constant.LOADED.isSet()) {
            Map<String, List<String>> contents = FileSection.parseSections(FileUtil.readFile(res + "lists" + File.separator + "TypeLists.txt"));
            for (String sectionName : contents.keySet()) {
                CardType.Helper.parseTypes(sectionName, contents.get(sectionName));
            }
            CardType.Constant.LOADED.set();
        }
        for (String s : FileUtil.readFile(res + "lists" + File.separator + "NonStackingKWList.txt")) {
            if (s.length() > 1) {
                CardUtil.NON_STACKING_LIST.add(s);
            }
        }
    }

    public static long getInitMillis() {
        return initMillis;
    }

    public static String defaultResDir() {
        return System.getProperty("forge.res", "../forge/forge-gui/res");
    }
}
