import Foundation
import CryptoKit
func require(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
require(DirectOtaProtocol.safeEntry("assets/index.js"), "normal asset")
for path in ["../secret", "/absolute", "a/../../file", "a\\b", "C:bad", "a\0b", "a/./b", "a//b", "a/", "a/\nb", "a/\u{7f}b", "cafe\u{301}.html", String(repeating: "a", count: 1025)] {
    require(!DirectOtaProtocol.safeEntry(path), "reject unsafe path")
}
require(DirectOtaProtocol.validRange("bytes 50-99/100", offset:50,total:100), "resume")
require(!DirectOtaProtocol.validRange("bytes 0-99/100", offset:50,total:100), "reject wrong range")
let key=P256.Signing.PrivateKey(), raw=key.publicKey.x963Representation
func b64(_ d: Data)->String {d.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
let runtime=String(repeating:"a",count:64)
let header=b64(try JSONSerialization.data(withJSONObject:["alg":"ES256","typ":"DIRECT-OTA","kid":"test"]))
var value:[String:Any]=["protocol":1,"appId":"app.example.demo","environment":"test","platform":"ios","channel":"production","runtime":runtime,"sequence":1,"backendContract":2,"rollout":100,"action":"withdraw","releaseId":UUID().uuidString.lowercased(),"version":"1.12.0","issuedAt":"2026-09-24T00:00:00Z"]
func sign(_ value:[String:Any])throws->String {let prefix=header+"."+b64(try JSONSerialization.data(withJSONObject:value));return prefix+"."+b64(try key.signature(for:Data(prefix.utf8)).rawRepresentation)}
func verify(_ token:String, limits: DirectOtaLimits = DirectOtaLimits(archiveBytes: 5242880, unpackedBytes: 26214400, files: 1000))throws->DirectOtaManifest {try DirectOtaProtocol.verify(token,keyId:"test",x:b64(raw.subdata(in:1..<33)),y:b64(raw.subdata(in:33..<65)),appId:"app.example.demo",environment:"test",artifactBaseUrl:"https://example.invalid/artifacts",backendContract:2,runtime:runtime,channel:"production",limits:limits)}
let signed=try sign(value)
require(try verify(signed).sequence == 1,"valid signed manifest")
do {_ = try verify(signed+"x");fatalError("accepted bad signature")} catch {}
value["runtime"]=String(repeating:"b",count:64)
do {_ = try verify(sign(value));fatalError("accepted incompatible runtime")} catch {}
value["runtime"]=runtime
let archiveHash=String(repeating:"c",count:64)
let artifactId=UUID().uuidString.lowercased()
value["action"]="release"
value["artifact"]=["path":"ios/\(runtime)/\(artifactId)/\(archiveHash).zip",
    "url":"https://example.invalid/artifacts/ios/\(runtime)/\(artifactId)/\(archiveHash).zip",
    "sha256":archiveHash,"bytes":6291456,"unpackedBytes":31457280,"files":1200,
    "checksum":Data(repeating:0,count:256).base64EncodedString(),
    "sessionKey":Data(repeating:0,count:16).base64EncodedString()+":"+Data(repeating:0,count:256).base64EncodedString()] as [String:Any]
do {_ = try verify(sign(value));fatalError("accepted oversized archive with default limits")} catch {}
let larger=DirectOtaLimits(archiveBytes:20971520,unpackedBytes:104857600,files:5000)
require(try verify(sign(value),limits:larger).artifact?.bytes == 6291456,"native-pinned larger limits")
value["mode"]="background"
require(try verify(sign(value),limits:larger).mode == "background","signed background mode")
value["mode"]="silent"
do {_ = try verify(sign(value),limits:larger);fatalError("accepted unknown update mode")} catch {}
value["mode"]="background"
do {_ = try verify(sign(value),limits:DirectOtaLimits(archiveBytes:52428801,unpackedBytes:104857600,files:5000));fatalError("accepted unsafe native limit")} catch {}
value["action"]="withdraw"; value.removeValue(forKey:"artifact")
do {_ = try verify(sign(value));fatalError("accepted background withdrawal")} catch {}
value.removeValue(forKey:"mode")
let corpus = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
var checked = 0
for line in corpus.split(separator: "\n") {
    let text = String(line), valid = text.hasPrefix("+")
    value["version"] = String(text.dropFirst())
    let accepted = (try? verify(sign(value))) != nil
    require(accepted == valid, "SemVer mismatch: \(text)")
    checked += 1
}
require(checked >= 10, "missing version cases")
value["version"]="1.12.0"
require(try verify(sign(value)).sequence == 1,"valid fuzz seed")
let seedId=value["releaseId"]!
value["releaseId"]="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
require((try? verify(sign(value))) == nil,"accepted noncanonical UUID case")
value["releaseId"]="aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa"
require((try? verify(sign(value))) == nil,"accepted UUID version zero")
value["releaseId"]=seedId
for index in 0..<1000 {
    var invalid=value
    switch index % 10 {
    case 0: invalid["sequence"]=0
    case 1: invalid["unexpected"]="field-\(index)"
    case 2: invalid["issuedAt"]="2026-02-30T00:00:00Z"
    case 3: invalid["version"]="01.0.\(index)"
    case 4: invalid["runtime"]=String(repeating:"b",count:64)
    case 5: invalid["action"]="unknown"
    case 6: invalid["releaseId"]="not-a-uuid"
    case 7: invalid["protocol"]=2
    case 8: invalid["rollout"]=101
    default: invalid["mode"]="background"
    }
    require((try? verify(sign(invalid))) == nil,"accepted signed malformed payload \(index)")
}
let original=try sign(value)
for index in 0..<256 {
    var bytes=Array(original.utf8)
    let offset=(index * 7919) % bytes.count
    bytes[offset]=bytes[offset] == 65 ? 66 : 65
    require((try? verify(String(decoding:bytes,as:UTF8.self))) == nil,"accepted mutated JWS \(index)")
}
print("Native protocol: signature, compatibility, archive path and range tests passed")
