package ee.forgr.capacitor_updater;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.Normalizer;
import java.security.*;
import java.security.spec.*;
import java.math.BigInteger;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.*;

/** Direct OTA extension of the pinned Capgo updater. All activation requires a native-verified JWS. */
final class DirectOta {
    boolean requiresVerifiedApi() { return true; }
    private final CapacitorUpdaterPlugin host;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private volatile boolean paused = false;
    private volatile HttpURLConnection connection;
    private volatile String phase = "idle", error;
    private volatile int received = 0;
    private volatile int transferTotal = 0;
    private volatile JSONObject manifest;
    private volatile long generation;
    private String watchedBundle;
    private String token;
    private Runnable watchdog;
    private long foregroundElapsed, lastTick;
    private final ConnectivityManager connectivity;
    private final ConnectivityManager.NetworkCallback callback;
    private String prefix() { return "direct-ota." + runtime() + "." + channel(); }
    private String runtime() { return host.getConfig().getString("directOtaRuntime", ""); }
    private String channel() { return host.getConfig().getString("directOtaChannel", ""); }
    private String appId() { return host.getConfig().getString("directOtaAppId", ""); }
    private String environment() { return host.getConfig().getString("directOtaEnvironment", ""); }
    private String artifactBaseUrl() { return host.getConfig().getString("directOtaArtifactBaseUrl", ""); }
    private int backendContract() { return host.getConfig().getInt("directOtaBackendContract", 0); }
    private int maxArchiveBytes() { return host.getConfig().getInt("directOtaMaxArchiveBytes", 5242880); }
    private int maxUnpackedBytes() { return host.getConfig().getInt("directOtaMaxUnpackedBytes", 26214400); }
    private int maxFiles() { return host.getConfig().getInt("directOtaMaxFiles", 1000); }
    private boolean validLimits() { return maxArchiveBytes()>=5242880&&maxArchiveBytes()<=52428800
        &&maxUnpackedBytes()>=26214400&&maxUnpackedBytes()<=104857600&&maxUnpackedBytes()>=maxArchiveBytes()
        &&maxFiles()>=1000&&maxFiles()<=5000; }
    boolean enabled() {
        try {
            URI uri = new URI(artifactBaseUrl());
            return runtime().matches("[0-9a-f]{64}") && (channel().equals("internal") || channel().equals("production"))
                && appId().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}") && environment().matches("[A-Za-z0-9_-]{1,40}") && backendContract() > 0 && validLimits()
                && uri.getScheme().equals("https") && uri.getHost() != null && uri.getRawUserInfo() == null
                && uri.getRawQuery() == null && uri.getRawFragment() == null && !artifactBaseUrl().endsWith("/")
                && uri.toASCIIString().equals(artifactBaseUrl()) && uri.getRawPath().matches("/[A-Za-z0-9/_-]*")
                && signingKeys().length() >= 1;
        } catch(Exception e) { return false; }
    }
    private String bundleId(String hash) { return "do" + hash.substring(0,30); }
    DirectOta(CapacitorUpdaterPlugin host) {
        this.host=host; prefs=host.getContext().getSharedPreferences("direct-ota",Context.MODE_PRIVATE);
        if(!prefs.contains("installation")) prefs.edit().putString("installation",UUID.randomUUID().toString()).commit();
        String saved=prefs.getString(prefix()+".manifest",null);
        if(saved!=null) try { JSONObject parsed=verify(saved);if(signingEpoch(saved)>=prefs.getInt(prefix()+".keyEpoch",0)){manifest=parsed;token=saved;} } catch(Exception ignored) {}
        connectivity=(ConnectivityManager)host.getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        callback=new ConnectivityManager.NetworkCallback(){
            @Override public void onLost(Network network){ networkChanged(); }
            @Override public void onCapabilitiesChanged(Network network,NetworkCapabilities capabilities){ networkChanged(); }
        };
        connectivity.registerDefaultNetworkCallback(callback);
    }
    private void networkChanged(){ main.post(()->{ if(downloading.get() && !networkAllowed()) pause(); emit(); }); }
    private String networkType(){ return networkType(connectivity.getActiveNetwork()); }
    private String networkType(Network network){
        NetworkCapabilities c=network==null?null:connectivity.getNetworkCapabilities(network);
        if(c==null || !c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))return "offline";
        return c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)&&c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)?"wifi":"cellular";
    }
    private boolean networkAllowed(){
        JSONObject m=manifest;JSONObject a=m==null?null:m.optJSONObject("artifact");
        return !networkType().equals("offline") && (networkType().equals("wifi") || (a!=null && !m.optString("mode").equals("background") && prefs.getBoolean(prefix()+".cellular."+a.optString("sha256"),false)));
    }
    private boolean networkAllowed(Network network,String hash){
        String type=networkType(network);
        return !type.equals("offline") && (type.equals("wifi") || (manifest!=null && !manifest.optString("mode").equals("background") && prefs.getBoolean(prefix()+".cellular."+hash,false)));
    }
    private boolean imported(String hash){
        try{return prefs.getBoolean(prefix()+".verified."+hash,false) && new File(CapgoUpdater.resolveBundleDirectory(host.implementation.documentsDir,bundleId(hash)),"index.html").isFile();}catch(Exception e){return false;}
    }
    private void clearRequirement(){generation++;pause();manifest=null;token=null;phase="idle";error=null;prefs.edit().remove(prefix()+".manifest").commit();emit();}
    private static void require(boolean value)throws IOException{if(!value)throw new IOException("OTA_INVALID");}
    private static byte[] b64(String value)throws Exception{
        require(value.matches("[A-Za-z0-9_-]+"));
        byte[] decoded=Base64.decode(value,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);
        require(value.equals(Base64.encodeToString(decoded,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING)));
        return decoded;
    }
    private JSONArray signingKeys()throws Exception{
        String id=host.getConfig().getString("directOtaKeyId",""),x=host.getConfig().getString("directOtaKeyX",""),y=host.getConfig().getString("directOtaKeyY","");
        require(id.matches("[A-Za-z0-9_-]{1,80}")&&b64(x).length==32&&b64(y).length==32);
        String raw=host.getConfig().getString("directOtaTrustedKeys","");
        if(raw.isEmpty())return new JSONArray().put(new JSONObject().put("keyId",id).put("x",x).put("y",y));
        require(raw.getBytes(StandardCharsets.UTF_8).length<=2048);
        JSONArray keys=new JSONArray(raw);require(keys.length()>=2&&keys.length()<=4);
        Set<String> seen=new HashSet<>();
        for(int i=0;i<keys.length();i++){
            JSONObject item=keys.getJSONObject(i);require(exactKeys(item,"keyId","x","y"));
            String kid=item.getString("keyId");require(kid.matches("[A-Za-z0-9_-]{1,80}")&&seen.add(kid)&&b64(item.getString("x")).length==32&&b64(item.getString("y")).length==32);
        }
        JSONObject first=keys.getJSONObject(0);
        require(first.getString("keyId").equals(id)&&first.getString("x").equals(x)&&first.getString("y").equals(y));
        return keys;
    }
    private int signingEpoch(String signed)throws Exception{
        String[] parts=signed.split("\\.",-1);require(parts.length==3);
        JSONObject header=new JSONObject(new String(b64(parts[0]),StandardCharsets.UTF_8));
        String id=header.getString("kid");JSONArray keys=signingKeys();
        for(int i=0;i<keys.length();i++)if(keys.getJSONObject(i).getString("keyId").equals(id))return i;
        throw new IOException("OTA_INVALID");
    }
    private static boolean exactKeys(JSONObject object,String... fields){
        Set<String> actual=new HashSet<>();Iterator<String> keys=object.keys();while(keys.hasNext())actual.add(keys.next());
        return actual.equals(new HashSet<>(Arrays.asList(fields)));
    }
    private static byte[] derSignature(byte[] raw)throws Exception{
        require(raw.length==64);
        byte[] r=new BigInteger(1,Arrays.copyOfRange(raw,0,32)).toByteArray(),s=new BigInteger(1,Arrays.copyOfRange(raw,32,64)).toByteArray();
        ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(0x30);out.write(r.length+s.length+4);out.write(2);out.write(r.length);out.write(r);out.write(2);out.write(s.length);out.write(s);return out.toByteArray();
    }
    private static boolean integer(JSONObject o,String key,long min,long max)throws Exception{
        Object value=o.get(key);if(!(value instanceof Number))return false;double d=((Number)value).doubleValue();return Double.isFinite(d)&&d==Math.floor(d)&&d>=min&&d<=max;
    }
    JSONObject verify(String signed)throws Exception{
        require(enabled() && signed.length()<=8192);
        String[] parts=signed.split("\\.",-1);require(parts.length==3);
        JSONObject h=new JSONObject(new String(b64(parts[0]),StandardCharsets.UTF_8));
        require(exactKeys(h,"alg","typ","kid")&&h.optString("alg").equals("ES256")&&h.optString("typ").equals("DIRECT-OTA"));
        JSONObject selected=signingKeys().getJSONObject(signingEpoch(signed));
        AlgorithmParameters parameters=AlgorithmParameters.getInstance("EC");parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec spec=parameters.getParameterSpec(ECParameterSpec.class);
        ECPoint point=new ECPoint(new BigInteger(1,b64(selected.getString("x"))),new BigInteger(1,b64(selected.getString("y"))));
        PublicKey key=KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point,spec));
        Signature verifier=Signature.getInstance("SHA256withECDSA");verifier.initVerify(key);verifier.update((parts[0]+"."+parts[1]).getBytes(StandardCharsets.UTF_8));require(verifier.verify(derSignature(b64(parts[2]))));
        JSONObject m=new JSONObject(new String(b64(parts[1]),StandardCharsets.UTF_8));
        String action=m.optString("action");
        require(action.equals("release") ? (m.has("mode") ? exactKeys(m,"protocol","appId","environment","platform","channel","runtime","sequence","backendContract","rollout","action","releaseId","version","issuedAt","artifact","mode") : exactKeys(m,"protocol","appId","environment","platform","channel","runtime","sequence","backendContract","rollout","action","releaseId","version","issuedAt","artifact")) : exactKeys(m,"protocol","appId","environment","platform","channel","runtime","sequence","backendContract","rollout","action","releaseId","version","issuedAt"));
        require(integer(m,"protocol",1,1)&&m.optString("appId").equals(appId())&&m.optString("environment").equals(environment())&&m.optString("platform").equals("android")&&m.optString("channel").equals(channel())&&m.optString("runtime").equals(runtime())&&integer(m,"backendContract",backendContract(),backendContract())&&integer(m,"sequence",1,9007199254740991L)&&integer(m,"rollout",0,100));
        require(m.getString("releaseId").matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")&&DirectOtaVersion.valid(m.getString("version")));
        String issued=m.getString("issuedAt");require(issued.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z"));
        java.text.SimpleDateFormat format=new java.text.SimpleDateFormat(issued.contains(".")?"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'":"yyyy-MM-dd'T'HH:mm:ss'Z'",Locale.ROOT);
        format.setLenient(false);format.setTimeZone(TimeZone.getTimeZone("UTC"));java.text.ParsePosition position=new java.text.ParsePosition(0);
        Date issuedDate=format.parse(issued,position);require(issuedDate!=null&&position.getIndex()==issued.length()&&issuedDate.getTime()<=System.currentTimeMillis()+300000L);
        if(m.optString("action").equals("withdraw")){require(!m.has("artifact")&&!m.has("mode"));return m;}
        require(m.optString("action").equals("release"));JSONObject a=m.getJSONObject("artifact");
        require(!m.has("mode")||m.getString("mode").equals("required")||m.getString("mode").equals("background"));
        require(a.has("delta") ? exactKeys(a,"path","url","sha256","bytes","unpackedBytes","files","checksum","sessionKey","delta") : exactKeys(a,"path","url","sha256","bytes","unpackedBytes","files","checksum","sessionKey"));
        require(integer(a,"bytes",1,maxArchiveBytes())&&integer(a,"unpackedBytes",1,maxUnpackedBytes())&&integer(a,"files",1,maxFiles())&&a.getString("sha256").matches("[0-9a-f]{64}"));
        String[] path=a.getString("path").split("/",-1);
        require(path.length==4&&path[0].equals("android")&&path[1].equals(runtime())&&path[2].matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")&&path[3].equals(a.getString("sha256")+".zip"));
        require(a.getString("url").equals(artifactBaseUrl()+"/"+a.getString("path")));
        String[] session=a.getString("sessionKey").split(":",-1);
        require(session.length==2&&Base64.decode(session[0],Base64.NO_WRAP).length==16&&Base64.decode(session[1],Base64.NO_WRAP).length==256);
        String checksum=a.getString("checksum");require(checksum.matches("[0-9a-f]{512}")||Base64.decode(checksum,Base64.NO_WRAP).length==256);
        if(a.has("delta")){
            JSONObject d=a.getJSONObject("delta");require(exactKeys(d,"fromSha256","baseChecksum","fullBytes","fullSha256","offset","bytes","sha256","checksum","sessionKey"));
            require(d.getString("fromSha256").matches("[0-9a-f]{64}")&&d.getString("baseChecksum").matches("[0-9a-f]{64}")&&
                d.getString("fullSha256").matches("[0-9a-f]{64}")&&d.getString("sha256").matches("[0-9a-f]{64}")&&
                !d.getString("fromSha256").equals(a.getString("sha256"))&&integer(d,"fullBytes",1,maxArchiveBytes())&&
                integer(d,"bytes",1,5242880)&&integer(d,"offset",1,maxArchiveBytes())&&
                d.getLong("offset")==d.getLong("fullBytes")&&d.getLong("bytes")<d.getLong("fullBytes")&&
                d.getLong("fullBytes")+d.getLong("bytes")==a.getLong("bytes"));
            String[] patchKey=d.getString("sessionKey").split(":",-1);
            require(patchKey.length==2&&Base64.decode(patchKey[0],Base64.NO_WRAP).length==16&&Base64.decode(patchKey[1],Base64.NO_WRAP).length==256);
            String patchChecksum=d.getString("checksum");require(patchChecksum.matches("[0-9a-f]{512}")||Base64.decode(patchChecksum,Base64.NO_WRAP).length==256);
        }
        return m;
    }
    private void recover(){
        try{
            if(manifest==null||!manifest.has("artifact"))return;
            String hash=manifest.getJSONObject("artifact").getString("sha256"),id=bundleId(hash);
            BundleInfo bundle=host.implementation.getBundleInfo(id);
            if(bundle.isErrorStatus()||prefs.getBoolean(prefix()+".failed."+hash,false)){
                prefs.edit().putBoolean(prefix()+".failed."+hash,true).remove(prefix()+".manifest").commit();manifest=null;token=null;phase="idle";error=null;
            }else if(host.implementation.getCurrentBundle().getId().equals(id)&&bundle.getStatus()==BundleStatus.SUCCESS){
                prefs.edit().remove(prefix()+".manifest").commit();manifest=null;token=null;phase="idle";error=null;
            }
        }catch(Exception ignored){}
    }
    synchronized JSObject state(){
        recover();JSObject s=new JSObject();s.put("enabled",enabled());s.put("platform","android");s.put("runtime",runtime());s.put("channel",channel());s.put("connection",networkType());s.put("phase",phase);s.put("received",received);s.put("installationId",prefs.getString("installation",""));s.put("current",host.implementation.getCurrentBundle().getId());
        if(token!=null&&manifest!=null){s.put("manifest",token);s.put("total",transferTotal>0?transferTotal:manifest.optJSONObject("artifact").optInt("bytes"));s.put("version",manifest.optString("version"));s.put("releaseId",manifest.optString("releaseId"));s.put("mode",manifest.optString("mode","required"));s.put("cellularAllowed",prefs.getBoolean(prefix()+".cellular."+manifest.optJSONObject("artifact").optString("sha256"),false));}if(error!=null)s.put("error",error);return s;
    }
    private void emit(){main.post(()->host.directOtaEmit(state()));}
    synchronized void accept(String signed)throws Exception{
        JSONObject m=verify(signed);long sequence=m.getLong("sequence"),highest=prefs.getLong(prefix()+".sequence",0);
        int epoch=signingEpoch(signed);if(epoch<prefs.getInt(prefix()+".keyEpoch",0))throw new IOException("OTA_REPLAY");
        if(sequence<highest || (sequence==highest&&!signed.equals(prefs.getString(prefix()+".latest",signed))))throw new IOException("OTA_REPLAY");
        prefs.edit().putLong(prefix()+".sequence",sequence).putString(prefix()+".latest",signed).putInt(prefix()+".keyEpoch",epoch).commit();
        if(m.getString("action").equals("withdraw")){clearRequirement();return;}
        String hash=m.getJSONObject("artifact").getString("sha256");if(prefs.getBoolean(prefix()+".failed."+hash,false))throw new IOException("OTA_QUARANTINED");
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(prefs.getString("installation","").getBytes(StandardCharsets.UTF_8));int cohort=(((digest[0]&255)*256)+(digest[1]&255))%10000;
        if(cohort>=m.getInt("rollout")*100&&manifest==null)return;
        if(host.implementation.getCurrentBundle().getId().equals(bundleId(hash))){clearRequirement();return;}
        if(!signed.equals(token)){generation++;pause();phase="required";error=null;received=0;transferTotal=m.getJSONObject("artifact").getInt("bytes");}
        manifest=m;token=signed;prefs.edit().putString(prefix()+".manifest",signed).commit();emit();
    }
    void pause(){paused=true;HttpURLConnection c=connection;if(c!=null)c.disconnect();if(downloading.get())phase="paused";emit();}
    synchronized void download(boolean cellular,PluginCall call){
        if(!downloading.compareAndSet(false,true)){call.reject("OTA_BUSY");return;}
        final JSONObject m=manifest; final long operation=generation;
        new Thread(()->{
            try{
                require(m!=null);JSONObject a=m.getJSONObject("artifact");String hash=a.getString("sha256"),id=bundleId(hash);
                if(cellular&&m.optString("mode").equals("background"))throw new IOException("OTA_PAUSED");
                if(cellular)prefs.edit().putBoolean(prefix()+".cellular."+hash,true).commit();
                if(!networkAllowed())throw new IOException("OTA_PAUSED");
                paused=false;error=null;
                if(!imported(hash) || host.implementation.getBundleInfo(id).isErrorStatus()){
                    File folder=new File(host.getContext().getNoBackupFilesDir(),"direct-ota");require(folder.isDirectory()||folder.mkdirs());
                    File[] stale=folder.listFiles();if(stale!=null)for(File file:stale)if(file.getName().matches("[0-9a-f]{64}\\.(part|zip|delta\\.part|delta\\.decoded)")&&!file.getName().startsWith(hash+"."))file.delete();
                    if(folder.getUsableSpace()<a.getLong("unpackedBytes")+3*a.getLong("bytes")+10485760)throw new IOException("OTA_STORAGE");
                    downloadAndImport(folder,m,a,id,hash,operation);
                }
                synchronized(this){
                    if(paused||manifest!=m||generation!=operation)throw new IOException("OTA_PAUSED");
                    prefs.edit().putBoolean(prefix()+".verified."+hash,true).commit();phase="ready";error=null;
                }
                main.post(()->call.resolve(state()));
            }catch(Exception e){final String code=e.getMessage()!=null&&e.getMessage().startsWith("OTA_")?e.getMessage():"OTA_NETWORK";synchronized(this){if(generation==operation){error=code;phase="paused";}}main.post(()->call.reject(code));}
            finally{HttpURLConnection finished=connection;if(finished!=null)finished.disconnect();connection=null;downloading.set(false);emit();}
        },"directOta-ota-download").start();
    }
    private void downloadAndImport(File folder,JSONObject m,JSONObject a,String id,String hash,long operation)throws Exception{
        JSONObject delta=a.optJSONObject("delta");int objectBytes=a.getInt("bytes");
        File zip=new File(folder,hash+".zip");boolean patched=false;
        try{
            if(delta!=null){
                File base=new File(folder,delta.getString("baseChecksum")+".base");
                if(base.isFile()&&base.length()<=5242880&&CryptoCipher.calcChecksum(base).equals(delta.getString("baseChecksum"))){
                    File part=new File(folder,hash+".delta.part"),decoded=new File(folder,hash+".delta.decoded");
                    try{
                        phase="downloading";transferTotal=delta.getInt("bytes");emit();
                        transfer(part,a.getString("url"),delta.getInt("bytes"),hash,delta.getInt("offset"),objectBytes);
                        if(paused||manifest!=m||generation!=operation)throw new IOException("OTA_PAUSED");
                        phase="verifying";emit();
                        require(CryptoCipher.calcChecksum(part).equals(delta.getString("sha256")));
                        Files.copy(part.toPath(),decoded.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                        CryptoCipher.decryptFile(decoded,host.implementation.publicKey,delta.getString("sessionKey"));
                        String patchChecksum=CryptoCipher.decryptChecksum(delta.getString("checksum"),host.implementation.publicKey);
                        require(patchChecksum.equals(CryptoCipher.calcChecksum(decoded)));
                        Files.write(zip.toPath(),applyDelta(Files.readAllBytes(base.toPath()),Files.readAllBytes(decoded.toPath())));
                        patched=true;part.delete();
                    }catch(Exception failure){
                        if("OTA_PAUSED".equals(failure.getMessage())||"OTA_NETWORK".equals(failure.getMessage()))throw failure;
                        part.delete();zip.delete();
                    }finally{decoded.delete();}
                }
            }
            String checksum=CryptoCipher.decryptChecksum(a.getString("checksum"),host.implementation.publicKey);
            if(patched&&!checksum.equals(CryptoCipher.calcChecksum(zip))){zip.delete();patched=false;}
            if(!patched){
                int fullBytes=delta==null?objectBytes:delta.getInt("fullBytes");
                String fullHash=delta==null?hash:delta.getString("fullSha256");
                File part=new File(folder,hash+".part");phase="downloading";transferTotal=fullBytes;emit();
                boolean valid=false;
                for(int attempt=0;attempt<2;attempt++){
                    transfer(part,a.getString("url"),fullBytes,hash,0,objectBytes);
                    if(paused||manifest!=m||generation!=operation)throw new IOException("OTA_PAUSED");
                    phase="verifying";emit();
                    if(CryptoCipher.calcChecksum(part).equals(fullHash)){valid=true;break;}
                    part.delete();
                    if(attempt==0){phase="downloading";received=0;emit();}
                }
                if(!valid)throw new IOException("OTA_INVALID");
                Files.copy(part.toPath(),zip.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                CryptoCipher.decryptFile(zip,host.implementation.publicKey,a.getString("sessionKey"));
                part.delete();
            }
            require(checksum.length()==64&&checksum.equals(CryptoCipher.calcChecksum(zip)));
            validateZip(zip,a);
            host.implementation.directOtaImport(zip,id,m.getString("version"),checksum);
            cacheBase(folder,zip,checksum);
        }finally{zip.delete();}
    }
    private void cacheBase(File folder,File zip,String checksum){
        if(zip.length()>5242880)return;
        try{
            File cache=new File(folder,checksum+".base");
            Files.copy(zip.toPath(),cache.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            cache.setLastModified(System.currentTimeMillis());
            File[] retained=folder.listFiles(file->file.getName().matches("[0-9a-f]{64}\\.base"));
            if(retained!=null&&retained.length>2){Arrays.sort(retained,Comparator.comparingLong(File::lastModified));for(int i=0;i<retained.length-2;i++)retained[i].delete();}
        }catch(Exception ignored){/* Cache is optional; the next update can download its full segment. */}
    }
    private void transfer(File partial,String url,int total,String hash,int offset,int objectTotal)throws Exception{
        try(RandomAccessFile file=new RandomAccessFile(partial,"rw")){
            if(file.length()>total)file.setLength(0);received=(int)file.length();if(received==total)return;
            // Bind to the selected Wi-Fi network; it cannot silently fall back to cellular.
            Network net=connectivity.getActiveNetwork();if(net==null||!networkAllowed(net,hash))throw new IOException("OTA_PAUSED");
            connection=(HttpURLConnection)net.openConnection(new URL(url));connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(45000);connection.setReadTimeout(45000);connection.setRequestProperty("Accept-Encoding","identity");
            if(received>0||offset>0||total<objectTotal)connection.setRequestProperty("Range","bytes="+(offset+received)+"-"+(offset+total-1));int code=connection.getResponseCode();
            if(code==408||code==429||code>=500)throw new IOException("OTA_NETWORK");
            if(code==200&&offset==0&&total==objectTotal){file.setLength(0);received=0;}
            else require(code==206&&("bytes "+(offset+received)+"-"+(offset+total-1)+"/"+objectTotal).equals(connection.getHeaderField("Content-Range")));
            long length=connection.getContentLengthLong();require(length<0||length==total-received);file.seek(received);emit();
            try(InputStream input=connection.getInputStream()){
                byte[] buffer=new byte[32768];int count,last=received;long lastEmission=SystemClock.elapsedRealtime();
                while((count=input.read(buffer))!=-1){if(paused||!networkAllowed(net,hash))throw new IOException("OTA_PAUSED");require(received+count<=total);file.write(buffer,0,count);received+=count;if(received-last>=32768||SystemClock.elapsedRealtime()-lastEmission>=1000){file.getFD().sync();last=received;lastEmission=SystemClock.elapsedRealtime();emit();}}
            }finally{file.getFD().sync();connection.disconnect();connection=null;}
            if(received!=total)throw new IOException("OTA_NETWORK");
        }
    }
    private void validateZip(File file,JSONObject a)throws Exception{
        // Standard ZIP central-directory attributes expose Unix symlinks, unlike ZipEntry.
        byte[] raw=Files.readAllBytes(file.toPath());int end=-1;
        for(int i=raw.length-22;i>=Math.max(0,raw.length-65557);i--){if(le32(raw,i)==0x06054b50L&&i+22+le16(raw,i+20)==raw.length){end=i;break;}}
        require(end>=0&&le16(raw,end+4)==0&&le16(raw,end+6)==0);
        int count=le16(raw,end+10);require(count==a.getInt("files")&&count==le16(raw,end+8)&&count<=maxFiles());
        long offset=le32(raw,end+16),length=le32(raw,end+12);require(offset+length==end);
        int at=(int)offset;
        for(int i=0;i<count;i++){
            require(at>=0&&at+46<=end&&le32(raw,at)==0x02014b50L);
            long mode=le32(raw,at+38)>>>16;require((mode&0170000)==0||(mode&0170000)==0100000);
            at+=46+le16(raw,at+28)+le16(raw,at+30)+le16(raw,at+32);
        }
        require(at==end);

        int files=0;long size=0;Set<String> names=new HashSet<>();
        // java.util.zip never creates symlinks; Capgo extraction writes regular files only.
        try(ZipFile zip=new ZipFile(file)){Enumeration<? extends ZipEntry> entries=zip.entries();byte[] buffer=new byte[32768];
            while(entries.hasMoreElements()){ZipEntry entry=entries.nextElement();String name=entry.getName();require(++files<=maxFiles()&&!entry.isDirectory()&&safeEntry(name)&&names.add(name));
                try(InputStream in=zip.getInputStream(entry)){int read;while((read=in.read(buffer))!=-1){size+=read;require(size<=a.getLong("unpackedBytes")&&size<=maxUnpackedBytes());}}
            }
        }
        require(files==a.getInt("files")&&size==a.getLong("unpackedBytes")&&names.contains("index.html"));
    }
    static boolean safeEntry(String name){
        if(name==null||name.isEmpty()||name.getBytes(StandardCharsets.UTF_8).length>1024||
            !Normalizer.isNormalized(name,Normalizer.Form.NFC)||name.startsWith("/")||
            name.contains("\\")||name.contains(":"))return false;
        String[] parts=name.split("/",-1);
        if(parts.length>32)return false;
        for(String part:parts)if(part.isEmpty()||part.equals(".")||part.equals(".."))return false;
        for(int i=0;i<name.length();i++){char c=name.charAt(i);if(c<32||(c>=127&&c<=159))return false;}
        return true;
    }
    private static long deltaWord(byte[] patch,int at)throws IOException{
        require(at>=0&&at+4<=patch.length);
        return ((long)(patch[at]&255)<<24)|((long)(patch[at+1]&255)<<16)|((long)(patch[at+2]&255)<<8)|(patch[at+3]&255);
    }
    static byte[] applyDelta(byte[] base,byte[] patch)throws Exception{
        byte[] magic="DOTA-DLT1".getBytes(StandardCharsets.US_ASCII);
        require(base.length<=5242880&&patch.length>=81&&patch.length<=5242880+900081);
        require(Arrays.equals(Arrays.copyOfRange(patch,0,9),magic));
        require(MessageDigest.isEqual(Arrays.copyOfRange(patch,9,41),MessageDigest.getInstance("SHA-256").digest(base)));
        long targetSize=deltaWord(patch,73),operations=deltaWord(patch,77);
        require(targetSize>=1&&targetSize<=5242880&&operations>=1&&operations<=100000);
        byte[] result=new byte[(int)targetSize];int cursor=81,written=0;
        for(long i=0;i<operations;i++){
            require(cursor<patch.length);int kind=patch[cursor++]&255;
            if(kind==0){
                long offset=deltaWord(patch,cursor),count=deltaWord(patch,cursor+4);cursor+=8;
                require(count>0&&offset<=base.length&&count<=base.length-offset&&count<=result.length-written);
                System.arraycopy(base,(int)offset,result,written,(int)count);written+=(int)count;
            }else if(kind==1){
                long count=deltaWord(patch,cursor);cursor+=4;
                require(count>0&&count<=result.length-written&&count<=patch.length-cursor);
                System.arraycopy(patch,cursor,result,written,(int)count);cursor+=(int)count;written+=(int)count;
            }else throw new IOException("OTA_INVALID");
        }
        require(cursor==patch.length&&written==result.length&&
            MessageDigest.isEqual(Arrays.copyOfRange(patch,41,73),MessageDigest.getInstance("SHA-256").digest(result)));
        return result;
    }
    private static int le16(byte[] bytes,int offset){return (bytes[offset]&255)|((bytes[offset+1]&255)<<8);}
    private static long le32(byte[] bytes,int offset){return (long)le16(bytes,offset)|((long)le16(bytes,offset+2)<<16);}
    boolean mayActivate(String id){try{return manifest!=null&&bundleId(manifest.getJSONObject("artifact").getString("sha256")).equals(id)&&imported(manifest.getJSONObject("artifact").getString("sha256"))&&!prefs.getBoolean(prefix()+".failed."+manifest.getJSONObject("artifact").getString("sha256"),false);}catch(Exception e){return false;}}
    void activate(PluginCall call){
        main.post(()->{try{require(manifest!=null&&!downloading.get()&&phase.equals("ready"));String id=bundleId(manifest.getJSONObject("artifact").getString("sha256"));require(mayActivate(id));phase="installing";emit();require(host.implementation.set(id));require(host.directOtaReload());call.resolve();}catch(Exception e){call.reject("OTA_INVALID");}});
    }
    synchronized void markReady(){
        if(watchdog!=null)main.removeCallbacks(watchdog);watchdog=null;watchedBundle=null;foregroundElapsed=0;prefs.edit().remove(prefix()+".launch").commit();
        try{JSONArray previous=new JSONArray(prefs.getString(prefix()+".successful","[]"));List<String> ids=new ArrayList<>();String current=host.implementation.getCurrentBundle().getId();for(int i=0;i<previous.length();i++){String id=previous.getString(i);if(!id.equals(current))ids.add(id);}if(!current.equals("builtin"))ids.add(current);while(ids.size()>2){String old=ids.remove(0);if(!mayActivate(old))host.implementation.delete(old);}prefs.edit().putString(prefix()+".successful",new JSONArray(ids).toString()).commit();}catch(Exception ignored){}recover();emit();
    }
    void watchReady(Runnable check){main.post(()->{
        BundleInfo current=host.implementation.getCurrentBundle();
        if(current.isBuiltin()||current.getStatus()==BundleStatus.SUCCESS)return;
        String id=current.getId();
        if(id.equals(watchedBundle)&&watchdog!=null)return;
        if(watchdog!=null)main.removeCallbacks(watchdog);
        if(!id.equals(watchedBundle)){
            if(id.equals(prefs.getString(prefix()+".launch",null))){prefs.edit().remove(prefix()+".launch").commit();new Thread(check,"directOta-ota-recovery").start();return;}
            foregroundElapsed=0;watchedBundle=id;prefs.edit().putString(prefix()+".launch",id).commit();
        }
        lastTick=SystemClock.elapsedRealtime();
        watchdog=new Runnable(){public void run(){long now=SystemClock.elapsedRealtime();if(host.getActivity()!=null&&host.getActivity().hasWindowFocus())foregroundElapsed+=Math.min(now-lastTick,1000);lastTick=now;if(foregroundElapsed>=30000){watchdog=null;prefs.edit().remove(prefix()+".launch").commit();new Thread(check,"directOta-ota-recovery").start();}else main.postDelayed(this,500);}};
        main.postDelayed(watchdog,500);
    });}
    void destroy(){pause();connectivity.unregisterNetworkCallback(callback);if(watchdog!=null)main.removeCallbacks(watchdog);}
}
