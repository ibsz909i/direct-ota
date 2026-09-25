package ee.forgr.capacitor_updater;

import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import static org.junit.Assert.*;

public class DirectOtaDeltaTest {
    private static void word(ByteArrayOutputStream out,int value){
        out.writeBytes(ByteBuffer.allocate(4).putInt(value).array());
    }
    @Test public void reconstructsAndRejectsCorruption()throws Exception{
        byte[] base="abcdef".getBytes(StandardCharsets.UTF_8),target="abcdef!".getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        out.writeBytes("DOTA-DLT1".getBytes(StandardCharsets.US_ASCII));
        out.writeBytes(MessageDigest.getInstance("SHA-256").digest(base));
        out.writeBytes(MessageDigest.getInstance("SHA-256").digest(target));
        word(out,7);word(out,2);
        out.write(0);word(out,0);word(out,6);
        out.write(1);word(out,1);out.write('!');
        byte[] patch=out.toByteArray();
        assertArrayEquals(target,DirectOta.applyDelta(base,patch));
        patch[patch.length-1]='?';
        try{DirectOta.applyDelta(base,patch);fail("accepted corrupted patch");}catch(Exception expected){}
        byte[] restored=out.toByteArray();
        try{DirectOta.applyDelta("wrong".getBytes(StandardCharsets.UTF_8),restored);fail("accepted wrong base");}catch(Exception expected){}
    }
}
