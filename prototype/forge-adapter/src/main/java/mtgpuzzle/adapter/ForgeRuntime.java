package mtgpuzzle.adapter;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import forge.CardStorageReader;
import forge.ImageKeys;
import forge.StaticData;
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
        initNow(resDir, lazyCards);
    }

    /**
     * res の中身（cardsfolder・editions・日本語の訳）を差し替えた後に、静的データを作り直す。
     * URL の問題では問題ごとにカードが違うので、問題を開くたびに呼ぶ（WebApi.useCards）
     */
    public static synchronized void reload(String resDir) {
        initNow(resDir, false);
    }

    private static void initNow(String resDir, boolean lazyCards) {
        long start = System.currentTimeMillis();
        phases.clear();
        lastMark = start;
        String res = resDir.endsWith(File.separator) ? resDir : resDir + File.separator;
        try {
            // カード生成時に画像キーを計算するため、画像キャッシュのディレクトリ設定が必須（実際には読まない）
            // 一時ディレクトリの作成は CheerpJ では遅い（約 1 秒）ので、res の下に作る
            String noImages = Files.createDirectories(Path.of(res, "_noimg")).toString() + File.separator;
            ImageKeys.initializeDirs(noImages, new HashMap<>(), noImages, noImages, noImages, noImages, noImages, noImages, noImages);

            mark("imageKeys");
            Lang.createInstance("en-US");
            Localizer.getInstance().initialize("en-US", res + "languages" + File.separator);
            // 日本語の訳（cardnames-ja-JP.txt があれば）。選択肢の日本語の文を作るのに使う（Ja、design/option-i18n.md）
            Ja.init(res + "languages" + File.separator);
            mark("localizer");

            // 絞り込んだバンドルでは中身が空のディレクトリが zip に入らないので、ここで作っておく
            for (String dir : new String[] {"cardsfolder", "tokenscripts", "editions"}) {
                Files.createDirectories(Path.of(res, dir));
            }
            CardStorageReader cardReader = new CardStorageReader(res + "cardsfolder", null, lazyCards);
            CardStorageReader tokenReader = new CardStorageReader(res + "tokenscripts", null, false);
            mark("cardReaders");
            String emptyDir = Files.createDirectories(Path.of(res, "_empty")).toString();
            new StaticData(cardReader, tokenReader, null, null,
                    res + "editions", emptyDir, res + "blockdata", res + "setlookup",
                    "LATEST_ART_ALL_EDITIONS", true, true, false, false);
            mark("staticData");

            loadDynamicGamedata(res);
            mark("typeLists");
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
            if (s.length() > 1 && !CardUtil.NON_STACKING_LIST.contains(s)) {
                CardUtil.NON_STACKING_LIST.add(s);
            }
        }
    }

    private static final Map<String, Long> phases = new java.util.LinkedHashMap<>();
    private static long lastMark;

    private static void mark(String phase) {
        long now = System.currentTimeMillis();
        phases.put(phase, now - lastMark);
        lastMark = now;
    }

    /** 初期化の内訳（ミリ秒）。ブラウザでの計測用 */
    public static Map<String, Long> getInitPhases() {
        return Map.copyOf(phases);
    }

    public static long getInitMillis() {
        return initMillis;
    }

    public static String defaultResDir() {
        return System.getProperty("forge.res", "../forge/forge-gui/res");
    }
}
