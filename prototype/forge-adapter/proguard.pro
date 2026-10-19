# ブラウザ（CheerpJ）向けに forge-adapter-all.jar を縮める（C2）。
# 実行: prototype/forge-adapter/shrink.sh
# 難読化と最適化はしない（Forge はリフレクションと名前に依存する箇所があり、不具合の切り分けも難しくなるため）。

-dontobfuscate
-dontoptimize
-dontwarn
-ignorewarnings
-dontnote

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Record,PermittedSubclasses,Exceptions

# JS から呼ぶ入口
-keep public class mtgpuzzle.adapter.WebApi { public static *; }
-keep public class mtgpuzzle.adapter.Smoke { public static void main(java.lang.String[]); }
-keep public class mtgpuzzle.adapter.ResBundler { public static void main(java.lang.String[]); }
-keep public class mtgpuzzle.adapter.Solver { public static void main(java.lang.String[]); }

# Guava EventBus は @Subscribe の付いたメソッドをリフレクションで探して呼ぶ
-keepclassmembers class * {
    @com.google.common.eventbus.Subscribe <methods>;
}

# enum の values() / valueOf() は Forge のスクリプト解析で名前から引かれる
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Forge 本体: 効果・誘発・置換効果などのクラスを、名前やコンストラクタ参照から生成する箇所がある。
# FORGE_KEEP で、残す範囲を切り替えて試す（shrink.sh から差し込む）。
