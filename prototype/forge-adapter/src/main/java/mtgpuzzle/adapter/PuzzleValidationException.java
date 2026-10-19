package mtgpuzzle.adapter;

/** 問題データが不正なとき（存在しないカード名など）に投げる */
public class PuzzleValidationException extends RuntimeException {
    public PuzzleValidationException(String message) {
        super(message);
    }
}
