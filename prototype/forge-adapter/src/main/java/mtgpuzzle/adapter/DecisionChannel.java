package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * ゲームスレッドと呼び出し側との受け渡し。
 * Forge のゲームループは PlayerController を同期的に呼ぶため、外部入力が必要な箇所では
 * ゲームスレッドをここでブロックさせ、呼び出し側（UI / Worker）から回答を受け取る。
 */
final class DecisionChannel {

    sealed interface Signal permits Pending, Finished, Failed, Halted { }
    record Pending(Decision decision) implements Signal { }
    /** 期限（このターン）を過ぎたので、ゲームスレッドを止めた */
    record Halted() implements Signal { }
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
    private volatile boolean haltRequested;

    // ---- ゲームスレッド側 ----

    List<String> ask(Decision.Kind kind, String prompt, List<Decision.Option> options, int min, int max) {
        return ask(kind, Decision.Prompt.text(prompt), options, min, max);
    }

    List<String> ask(Decision.Kind kind, Decision.Prompt prompt, List<Decision.Option> options, int min, int max) {
        Decision d = new Decision(++seq, kind, prompt.text(), List.copyOf(options), min, max, prompt.key(), Map.copyOf(prompt.args()), prompt.source());
        try {
            toCaller.put(new Pending(d));
            List<String> answer = toGame.take();
            answerLog.add(answer);
            return answer;
        } catch (InterruptedException e) {
            throw new Aborted();
        }
    }

    /** 期限を過ぎたら、次にコントローラーが呼ばれた所でゲームを止める（イベントの購読から呼ぶ） */
    void requestHalt() {
        haltRequested = true;
    }

    /** 止める要求があれば、呼び出し側に Halted を送ってゲームスレッドを打ち切る */
    void checkHalt() {
        if (haltRequested) {
            toCaller.add(new Halted());
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
