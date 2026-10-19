package mtgpuzzle.teavm;

import mtgpuzzle.adapter.WebApi;

/**
 * TeaVM の変換可否を確かめるための入口。
 * WebApi 全体（Forge の初期化 → パズル読み込み → 回答）を到達可能にして、未対応 API をビルド時に洗い出す。
 */
public final class TeaVMMain {
    private TeaVMMain() { }

    public static void main(String[] args) {
        System.out.println(WebApi.init("/res-mini.zip", "/forge-res"));
        System.out.println(WebApi.load("{}"));
        System.out.println(WebApi.submit("[\"pass\"]"));
        System.out.println(WebApi.reset());
        System.out.println(WebApi.state());
    }
}
