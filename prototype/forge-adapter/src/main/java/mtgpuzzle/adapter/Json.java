package mtgpuzzle.adapter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 最小限の JSON パーサー／シリアライザ。
 * ブラウザに送る jar を小さくするため、Jackson（約 1.9 MB）の代わりに使う。リフレクションも使わない。
 * パース結果は Map / List / String / Long / Double / Boolean / null。
 */
public final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    public static Object parse(String text) {
        Json p = new Json(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) {
            throw p.error("余分な文字があります");
        }
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object v = parse(text);
        if (!(v instanceof Map)) {
            throw new IllegalArgumentException("JSON オブジェクトではありません");
        }
        return (Map<String, Object>) v;
    }

    public static List<String> parseStringArray(String text) {
        Object v = parse(text);
        if (!(v instanceof List<?> list)) {
            throw new IllegalArgumentException("JSON 配列ではありません");
        }
        List<String> out = new ArrayList<>();
        for (Object o : list) {
            out.add(String.valueOf(o));
        }
        return out;
    }

    private Object value() {
        if (i >= s.length()) {
            throw error("値がありません");
        }
        char c = s.charAt(i);
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': expect("true"); return Boolean.TRUE;
            case 'f': expect("false"); return Boolean.FALSE;
            case 'n': expect("null"); return null;
            default: return number();
        }
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++;
        ws();
        if (peek('}')) {
            i++;
            return m;
        }
        while (true) {
            ws();
            String key = string();
            ws();
            take(':');
            ws();
            m.put(key, value());
            ws();
            if (peek(',')) {
                i++;
                continue;
            }
            take('}');
            return m;
        }
    }

    private List<Object> array() {
        List<Object> list = new ArrayList<>();
        i++;
        ws();
        if (peek(']')) {
            i++;
            return list;
        }
        while (true) {
            ws();
            list.add(value());
            ws();
            if (peek(',')) {
                i++;
                continue;
            }
            take(']');
            return list;
        }
    }

    private String string() {
        take('"');
        StringBuilder sb = new StringBuilder();
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') {
                return sb.toString();
            }
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            char e = s.charAt(i++);
            switch (e) {
                case 'n': sb.append('\n'); break;
                case 't': sb.append('\t'); break;
                case 'r': sb.append('\r'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'u': sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                default: sb.append(e);
            }
        }
        throw error("文字列が閉じていません");
    }

    private Object number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
            i++;
        }
        String n = s.substring(start, i);
        if (n.isEmpty()) {
            throw error("不正な値");
        }
        if (n.contains(".") || n.contains("e") || n.contains("E")) {
            return Double.parseDouble(n);
        }
        return Long.parseLong(n);
    }

    private void expect(String word) {
        if (!s.startsWith(word, i)) {
            throw error(word + " を期待しました");
        }
        i += word.length();
    }

    private boolean peek(char c) {
        return i < s.length() && s.charAt(i) == c;
    }

    private void take(char c) {
        if (!peek(c)) {
            throw error("'" + c + "' を期待しました");
        }
        i++;
    }

    private void ws() {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
            i++;
        }
    }

    private IllegalArgumentException error(String msg) {
        return new IllegalArgumentException("JSON の解析に失敗しました（位置 " + i + "）: " + msg);
    }

    // ---------------- 出力 ----------------

    public static String stringify(Object v) {
        StringBuilder sb = new StringBuilder();
        write(sb, v);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String str) {
            quote(sb, str);
        } else if (v instanceof Number || v instanceof Boolean) {
            sb.append(v);
        } else if (v instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                quote(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object o : it) {
                if (!first) sb.append(',');
                first = false;
                write(sb, o);
            }
            sb.append(']');
        } else if (v instanceof Enum<?> en) {
            quote(sb, en.name());
        } else {
            quote(sb, v.toString());
        }
    }

    private static void quote(StringBuilder sb, String str) {
        sb.append('"');
        for (int k = 0; k < str.length(); k++) {
            char c = str.charAt(k);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }
}
