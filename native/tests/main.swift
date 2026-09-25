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
func verify(_ token:String, limits: DirectOtaLimits = DirectOtaLimits(archiveBytes: 5242880, unpackedBytes: 26214400, files: 1000), ring:String? = nil)throws->DirectOtaManifest {try DirectOtaProtocol.verify(token,keyId:"test",x:b64(raw.subdata(in:1..<33)),y:b64(raw.subdata(in:33..<65)),appId:"app.example.demo",environment:"test",artifactBaseUrl:"https://example.invalid/artifacts",backendContract:2,runtime:runtime,channel:"production",limits:limits,trustedKeysJSON:ring)}
let signed=try sign(value)
require(try verify(signed).sequence == 1,"valid signed manifest")
let next=P256.Signing.PrivateKey(), nextRaw=next.publicKey.x963Representation
let ring=String(data:try JSONSerialization.data(withJSONObject:[
    ["keyId":"test","x":b64(raw.subdata(in:1..<33)),"y":b64(raw.subdata(in:33..<65))],
    ["keyId":"next","x":b64(nextRaw.subdata(in:1..<33)),"y":b64(nextRaw.subdata(in:33..<65))]
]),encoding:.utf8)!
let nextHeader=b64(try JSONSerialization.data(withJSONObject:["alg":"ES256","typ":"DIRECT-OTA","kid":"next"]))
let nextPrefix=nextHeader+"."+b64(try JSONSerialization.data(withJSONObject:value))
let nextSigned=nextPrefix+"."+b64(try next.signature(for:Data(nextPrefix.utf8)).rawRepresentation)
require(try verify(nextSigned,ring:ring).sequence == 1,"next pinned key")
require(try DirectOtaProtocol.signerIndex(nextSigned,keys:DirectOtaProtocol.signingKeys(ring,keyId:"test",x:b64(raw.subdata(in:1..<33)),y:b64(raw.subdata(in:33..<65)))) == 1,"monotonic key epoch")
require((try? verify(nextSigned)) == nil,"next key requires native pinning")
require((try? verify(signed,ring:ring.replacingOccurrences(of:"next",with:"test"))) == nil,"duplicate signing key")
let deltaBase=Data("abcdef".utf8), deltaTarget=Data("abcdef!".utf8)
func word(_ value:UInt32)->Data { Data([UInt8(value >> 24),UInt8((value >> 16)&255),UInt8((value >> 8)&255),UInt8(value&255)]) }
var patch=Data("DOTA-DLT1".utf8)
patch.append(Data(SHA256.hash(data:deltaBase)));patch.append(Data(SHA256.hash(data:deltaTarget)))
patch.append(word(7));patch.append(word(2))
patch.append(0);patch.append(word(0));patch.append(word(6))
patch.append(1);patch.append(word(1));patch.append(Data("!".utf8))
require(try DirectOtaProtocol.applyDelta(base:deltaBase,patch:patch)==deltaTarget,"binary delta reconstruction")
patch[patch.count-1]=UInt8(ascii:"?")
require((try? DirectOtaProtocol.applyDelta(base:deltaBase,patch:patch)) == nil,"corrupted binary delta")
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
var compound=value
var full=compound["artifact"] as! [String:Any]
full["bytes"]=180
let envelope=Data(repeating:0,count:256).base64EncodedString()
full["delta"]=["fromSha256":String(repeating:"a",count:64),"baseChecksum":String(repeating:"b",count:64),
    "fullBytes":100,"fullSha256":String(repeating:"d",count:64),"offset":100,"bytes":80,
    "sha256":String(repeating:"e",count:64),"checksum":envelope,
    "sessionKey":Data(repeating:0,count:16).base64EncodedString()+":"+envelope] as [String:Any]
compound["artifact"]=full
require(try verify(sign(compound),limits:larger).artifact?.delta?.bytes == 80,"signed compound artifact")
var wrong=full;var wrongDelta=wrong["delta"] as! [String:Any];wrongDelta["offset"]=99;wrong["delta"]=wrongDelta;compound["artifact"]=wrong
require((try? verify(sign(compound),limits:larger)) == nil,"reject wrong delta range")
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
