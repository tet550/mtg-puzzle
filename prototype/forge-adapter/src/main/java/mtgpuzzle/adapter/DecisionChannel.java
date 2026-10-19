package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * ゲームスレッドと呼び出し側との受け渡し。
 * Forge のゲームループは PlayerController を同期的に呼ぶため、外部入力が必要な箇所では
 * ゲームスレッドをここでブロックさせ、呼び出し側（UI / Worker）から回答を受け取る。
 */
final class DecisionChannel {

    sealed interface Signal permits Pending, Finished, Failed { }
    record Pending(Decision decision) implements Signal { }
    record Finished() implements Signal { }
    record Failed(Throwable error) implements Signal { }

    /** reset などでゲームスレッドを打ち切るときに投げる */
    static final class Aborted extends RuntimeException {
        Aborted() { super("game aborted"); }
    }

    private final BlockingQueue<Signal> toCaller = new LinkedBlockingQueue<>();
    private final BlockingQueue<List<String>> toGame = new LinkedBlockingQueue<>();
    private final List<List<String>> answerLog = new ArrayList<>();
    private int seq;

    // ---- ゲームスレッド側 ----

    List<String> ask(Decision.Kind kind, String prompt, List<Decision.Option> options, int min, int max) {
        Decision d = new Decision(++seq, kind, prompt, List.copyOf(options), min, max);
        try {
            toCaller.put(new Pending(d));
            List<String> answer = toGame.take();
            answerLog.add(answer);
            return answer;
        } catch (InterruptedException e) {
            throw new Aborted();
        }
    }

    void finished() {
        toCaller.add(new Finished());
    }

    void failed(Throwable t) {
        toCaller.add(new Failed(t));
    }

    // ---- 呼び出し側 ----

    Signal await(long timeoutMillis) {
        try {
            Signal s = toCaller.poll(timeoutMillis, TimeUnit.MILLISECONDS);
            if (s == null) {
                return new Failed(new IllegalStateException("ゲームスレッドが応答しません（" + timeoutMillis + "ms）"));
            }
            return s;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Failed(e);
        }
    }

    void answer(List<String> optionIds) {
        toGame.add(List.copyOf(optionIds));
    }

    List<List<String>> answerLog() {
        return List.copyOf(answerLog);
    }
}
