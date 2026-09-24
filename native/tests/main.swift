import Foundation
import CryptoKit
func require(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
require(DirectOtaProtocol.safeEntry("assets/index.js"), "normal asset")
for path in ["../secret", "/absolute", "a/../../file", "a\\b", "C:bad", "a\0b"] { require(!DirectOtaProtocol.safeEntry(path), "reject unsafe path") }
require(DirectOtaProtocol.validRange("bytes 50-99/100", offset:50,total:100), "resume")
require(!DirectOtaProtocol.validRange("bytes 0-99/100", offset:50,total:100), "reject wrong range")
let key=P256.Signing.PrivateKey(), raw=key.publicKey.x963Representation
func b64(_ d: Data)->String {d.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
let runtime=String(repeating:"a",count:64)
let header=b64(try JSONSerialization.data(withJSONObject:["alg":"ES256","typ":"DIRECT-OTA","kid":"test"]))
var value:[String:Any]=["protocol":1,"appId":"app.example.demo","environment":"test","platform":"ios","channel":"production","runtime":runtime,"sequence":1,"backendContract":2,"rollout":100,"action":"withdraw","releaseId":UUID().uuidString.lowercased(),"version":"1.12.0","issuedAt":"2026-09-24T00:00:00Z"]
func sign(_ value:[String:Any])throws->String {let prefix=header+"."+b64(try JSONSerialization.data(withJSONObject:value));return prefix+"."+b64(try key.signature(for:Data(prefix.utf8)).rawRepresentation)}
func verify(_ token:String)throws->DirectOtaManifest {try DirectOtaProtocol.verify(token,keyId:"test",x:b64(raw.subdata(in:1..<33)),y:b64(raw.subdata(in:33..<65)),appId:"app.example.demo",environment:"test",artifactBaseUrl:"https://example.invalid/artifacts",backendContract:2,runtime:runtime,channel:"production")}
let signed=try sign(value)
require(try verify(signed).sequence == 1,"valid signed manifest")
do {_ = try verify(signed+"x");fatalError("accepted bad signature")} catch {}
value["runtime"]=String(repeating:"b",count:64)
do {_ = try verify(sign(value));fatalError("accepted incompatible runtime")} catch {}
print("Native protocol: signature, compatibility, archive path and range tests passed")
