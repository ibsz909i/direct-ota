package ee.forgr.capacitor_updater;

import java.nio.file.Files;
import java.nio.file.Path;

public final class VersionCorpus {
    public static void main(String[] args) throws Exception {
        int checked = 0;
        for (String line : Files.readAllLines(Path.of(args[0]))) {
            if (line.isEmpty()) continue;
            boolean expected = line.charAt(0) == '+';
            if (DirectOtaVersion.valid(line.substring(1)) != expected) {
                throw new AssertionError("SemVer mismatch: " + line);
            }
            checked++;
        }
        if (checked < 10) throw new AssertionError("Missing version cases");
        System.out.println("Android SemVer corpus: " + checked + " cases passed");
    }
}
