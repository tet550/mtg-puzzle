package mtgpuzzle.adapter;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * URL で渡された問題（どのカードが来るか前もって分からない）のために、全カードのデータを作る（ビルド時ツール）。
 * design/carddata-runtime.md
 *
 * - 共通の res バンドル（zip）: カード以外（blockdata・setlookup・型リストなど）
 * - カードデータ（JSON を gzip）: 全カード・全トークンのスクリプトと、カードごとのエディション・日本語の訳・依存するカードとトークン
 *
 * ブラウザは問題を開くときにカードデータから問題のカード（と依存するカード）だけを抜き出し、
 * WebApi.useCards で Forge に渡す。Forge には問題のカードだけを読ませる（全カードの読み込みは重すぎる）。
 *
 * 使い方: CardData <forge res dir> <出力: 共通の zip> <出力: カードデータ .json.gz>
 */
public final class CardData {
    static final String FORGE_VERSION = "2.0.15";
    private static final Pattern NAME = Pattern.compile("^Name:(.*)$", Pattern.MULTILINE);
    /** スクリプトの中の、ほかのカードの名前を書く行（合体の相手・面のコピー元） */
    private static final Pattern NAME_LINE = Pattern.compile("^(?:MeldPair|CopyFaceFrom):(.*)$", Pattern.MULTILINE);
    /**
     * 名前でカードを作る能力のパラメーター（MakeCard の Name$・Names$・DefinedName$・Spellbook$、CopyPermanent の DefinedName$ など）。
     * 値がカード名ならそのカードに依存する。「カード名を 1 つ選ぶ」ような、どのカードでもよいものは扱えない
     */
    private static final Pattern PARAM = Pattern.compile("\\b(?:Name|Names|DefinedName|Spellbook|SpellbookName)\\$\\s*([^|\\r\\n]+)");

    /**
     * どの問題にも入れるトークン。スクリプトに名前の出ないもの:
     * ダンジョン（探索・イニシアチブ。VentureEffect が全トークンから探す）と、Forge のコードが名前で作るもの（Amass・Empower・Endure）
     */
    private static final List<String> ALWAYS_TOKENS = List.of("b_0_0_army", "u_empower", "w_x_x_spirit");

    private CardData() { }

    public static void main(String[] args) throws IOException {
        Path res = Path.of(args[0]);
        Path baseZip = Path.of(args[1]);
        Path out = Path.of(args[2]);

        // カード名（小文字）→ スクリプトのファイル。同じ名前が複数のファイルにあれば最初のもの（ResBundler と同じ）
        List<Path> files;
        try (Stream<Path> walk = Files.walk(res.resolve("cardsfolder"))) {
            files = walk.filter(p -> p.toString().endsWith(".txt")).sorted().toList();
        }
        Map<String, Integer> keys = new TreeMap<>();
        List<String> scripts = new ArrayList<>();
        List<List<String>> faces = new ArrayList<>();
        for (Path f : files) {
            String s = Files.readString(f, StandardCharsets.UTF_8);
            List<String> names = new ArrayList<>();
            Matcher m = NAME.matcher(s);
            while (m.find()) names.add(m.group(1).trim());
            if (names.isEmpty()) continue;
            int i = scripts.size();
            scripts.add(s);
            faces.add(names);
            for (String n : names) keys.putIfAbsent(n.toLowerCase(), i);
        }

        // 日本語の訳: 名前（小文字）→ 行（ResBundler.readJa と同じ読み方）
        Map<String, StringBuilder> ja = ResBundler.readJa(res);

        // トークン: 名前 → スクリプトと、そのトークンが作るトークン、日本語の訳
        Map<String, Object> tokens = new TreeMap<>();
        List<String> always = new ArrayList<>(ALWAYS_TOKENS);
        try (Stream<Path> walk = Files.list(res.resolve("tokenscripts"))) {
            for (Path f : walk.filter(p -> p.toString().endsWith(".txt")).sorted().toList()) {
                String name = f.getFileName().toString().replaceFirst("\\.txt$", "");
                String s = Files.readString(f, StandardCharsets.UTF_8);
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("s", s);
                Set<String> made = tokenNames(s);
                made.remove(name);
                if (!made.isEmpty()) t.put("t", new ArrayList<>(made));
                Matcher tm = NAME.matcher(s);
                StringBuilder tj = new StringBuilder();
                while (tm.find()) {
                    StringBuilder l = ja.get(tm.group(1).trim().toLowerCase());
                    if (l != null) tj.append(l);
                }
                if (!tj.isEmpty()) t.put("j", tj.toString());
                tokens.put(name, t);
                if (s.lines().anyMatch(l -> l.startsWith("Types:") && l.contains("Dungeon"))) always.add(name);
            }
        }
        always.removeIf(t -> !tokens.containsKey(t));

        Set<String> allNames = new TreeSet<>(keys.keySet());
        Map<String, Path> editionOf = ResBundler.pickEditions(res.resolve("editions"), allNames);

        List<Map<String, Object>> cards = new ArrayList<>();
        Map<String, String> editions = new TreeMap<>();
        int withDeps = 0;
        for (int i = 0; i < scripts.size(); i++) {
            String s = scripts.get(i);
            List<String> names = faces.get(i);
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("f", files.get(i).getFileName().toString());
            c.put("s", s);
            Path ed = editionOf.get(names.get(0).toLowerCase());
            if (ed != null) {
                String e = ed.getFileName().toString();
                c.put("e", e);
                editions.computeIfAbsent(e, k -> read(ed));
            }
            Set<String> deps = dependencies(s, names, keys);
            if (!deps.isEmpty()) {
                c.put("d", new ArrayList<>(deps));
                withDeps++;
            }
            Set<String> made = tokenNames(s);
            made.retainAll(tokens.keySet());
            if (!made.isEmpty()) c.put("t", new ArrayList<>(made));
            StringBuilder j = new StringBuilder();
            for (String n : names) {
                StringBuilder l = ja.get(n.toLowerCase());
                if (l != null) j.append(l);
            }
            if (!j.isEmpty()) c.put("j", j.toString());
            cards.add(c);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("forge", FORGE_VERSION);
        data.put("keys", keys);
        data.put("cards", cards);
        data.put("editions", editions);
        data.put("tokens", tokens);
        data.put("alwaysTokens", always);
        Files.createDirectories(out.toAbsolutePath().getParent());
        try (OutputStream o = new GZIPOutputStream(Files.newOutputStream(out), 1 << 16)) {
            o.write(Json.stringify(data).getBytes(StandardCharsets.UTF_8));
        }
        System.out.println("cards=" + cards.size() + " names=" + keys.size() + " withDeps=" + withDeps
                + " editions=" + editions.size() + " tokens=" + tokens.size() + " always=" + always + " -> " + out + " (" + Files.size(out) / 1024 + " KB)");

        writeBaseZip(res, baseZip);
        System.out.println("base -> " + baseZip + " (" + Files.size(baseZip) / 1024 + " KB)");
    }

    /** カードデータ（.json.gz）を読む。JVM での確かめ用（ブラウザでは Worker が読む） */
    static Map<String, Object> load(Path gz) throws IOException {
        try (java.io.InputStream in = new java.util.zip.GZIPInputStream(Files.newInputStream(gz))) {
            return Json.parseObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    /** 問題で使うカード名（WebApi.useCards に渡す前に、カードデータから抜き出す対象） */
    static Set<String> cardNames(PuzzleDefinition def) {
        Set<String> names = new TreeSet<>();
        for (PuzzleDefinition.PlayerDef pl : def.game.players) {
            for (List<PuzzleDefinition.CardDef> zone : List.of(pl.hand, pl.battlefield, pl.graveyard, pl.exile, pl.library)) {
                zone.forEach(c -> names.add(c.cardId));
            }
        }
        return names;
    }

    /**
     * カードデータから、names のカードと、それが依存するカードを抜き出して WebApi.useCards の引数を作る。
     * app/public/engine/worker.js の selectCards と同じ処理（JVM での確かめ用）
     */
    @SuppressWarnings("unchecked")
    static String select(Map<String, Object> data, Set<String> names) {
        Map<String, Object> keys = (Map<String, Object>) data.get("keys");
        List<Map<String, Object>> all = (List<Map<String, Object>>) data.get("cards");
        Map<String, Object> eds = (Map<String, Object>) data.get("editions");
        Map<String, Map<String, Object>> allTokens = (Map<String, Map<String, Object>>) data.get("tokens");
        Set<Integer> picked = new TreeSet<>();
        List<String> todo = new ArrayList<>();
        names.forEach(n -> todo.add(n.split(" // ", 2)[0].trim().toLowerCase()));
        while (!todo.isEmpty()) {
            Object i = keys.get(todo.remove(todo.size() - 1));
            if (i == null || !picked.add(((Number) i).intValue())) continue;
            Object deps = all.get(((Number) i).intValue()).get("d");
            if (deps != null) todo.addAll((List<String>) deps);
        }
        List<Map<String, Object>> cards = new ArrayList<>();
        Map<String, Object> editions = new TreeMap<>();
        StringBuilder ja = new StringBuilder();
        List<String> tokenTodo = new ArrayList<>((List<String>) data.get("alwaysTokens"));
        for (int i : picked) {
            Map<String, Object> c = all.get(i);
            cards.add(Map.of("f", c.get("f"), "s", c.get("s")));
            if (c.get("e") != null) editions.put((String) c.get("e"), eds.get(c.get("e")));
            if (c.get("j") != null) ja.append(c.get("j"));
            if (c.get("t") != null) tokenTodo.addAll((List<String>) c.get("t"));
        }
        Map<String, Object> tokens = new TreeMap<>();
        while (!tokenTodo.isEmpty()) {
            String t = tokenTodo.remove(tokenTodo.size() - 1);
            Map<String, Object> tk = allTokens.get(t);
            if (tk == null || tokens.containsKey(t)) continue;
            tokens.put(t, tk.get("s"));
            if (tk.get("j") != null) ja.append(tk.get("j"));
            if (tk.get("t") != null) tokenTodo.addAll((List<String>) tk.get("t"));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("key", String.join(",", new TreeSet<>(names.stream().map(String::toLowerCase).toList())));
        out.put("cards", cards);
        out.put("editions", editions);
        out.put("tokens", tokens);
        out.put("ja", ja.toString());
        return Json.stringify(out);
    }

    /** スクリプトの TokenScript$ にあるトークンの名前（ResBundler と同じ読み方） */
    static Set<String> tokenNames(String script) {
        Set<String> names = new TreeSet<>();
        Matcher m = ResBundler.TOKEN_SCRIPT.matcher(script);
        while (m.find()) {
            for (String t : m.group(1).split(",")) names.add(t.trim());
        }
        return names;
    }

    /** スクリプトが名前で参照しているほかのカード（小文字）。デッキ作りの手がかり（DeckHints など）は除く */
    static Set<String> dependencies(String script, List<String> self, Map<String, Integer> keys) {
        Set<String> own = new TreeSet<>();
        self.forEach(n -> own.add(n.toLowerCase()));
        Set<String> deps = new TreeSet<>();
        Matcher m = NAME_LINE.matcher(script);
        while (m.find()) add(deps, m.group(1), own, keys);
        for (String line : script.split("\\R")) {
            if (line.startsWith("Deck") || line.startsWith("Oracle:") || line.startsWith("Name:")) continue;
            Matcher p = PARAM.matcher(line);
            while (p.find()) {
                for (String v : p.group(1).split(",")) add(deps, v, own, keys);
            }
        }
        return deps;
    }

    private static void add(Set<String> deps, String name, Set<String> own, Map<String, Integer> keys) {
        String n = name.trim().toLowerCase();
        if (!n.isEmpty() && !own.contains(n) && keys.containsKey(n)) deps.add(n);
    }

    /** カード以外の res（ResBundler の共通部分。カード・トークン・エディション・日本語の訳は問題ごとに useCards で書く） */
    private static void writeBaseZip(Path res, Path out) throws IOException {
        Files.createDirectories(out.toAbsolutePath().getParent());
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(out))) {
            for (String dir : ResBundler.WHOLE_DIRS) putDir(zip, res, dir);
            for (String f : ResBundler.FILES) {
                zip.putNextEntry(new ZipEntry(f));
                Files.copy(res.resolve(f), zip);
                zip.closeEntry();
            }
        }
    }

    private static void putDir(ZipOutputStream zip, Path res, String dir) throws IOException {
        try (Stream<Path> walk = Files.walk(res.resolve(dir))) {
            for (Path f : walk.filter(Files::isRegularFile).sorted().toList()) {
                zip.putNextEntry(new ZipEntry(res.relativize(f).toString().replace(File.separatorChar, '/')));
                Files.copy(f, zip);
                zip.closeEntry();
            }
        }
    }

    private static String read(Path p) {
        try {
            return Files.readString(p, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
