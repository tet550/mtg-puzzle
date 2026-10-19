package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;

import forge.game.player.Player;

/** 外部入力に置き換えていない選択を AI が代行した記録。対応が必要な選択を洗い出すために使う */
final class FallbackLog {
    private final List<String> entries = new ArrayList<>();

    synchronized void add(Player p, String what) {
        entries.add(p.getName() + ": " + what);
    }

    synchronized List<String> entries() {
        return List.copyOf(entries);
    }
}
