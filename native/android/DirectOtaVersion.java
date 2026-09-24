package ee.forgr.capacitor_updater;

import java.util.regex.Pattern;

/** SemVer 2.0 grammar and bound shared with the public manifest validator. */
final class DirectOtaVersion {
    private static final Pattern VERSION = Pattern.compile(
        "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?"
    );
    static boolean valid(String version) {
        return version != null && version.length() <= 64 && VERSION.matcher(version).matches();
    }
}
