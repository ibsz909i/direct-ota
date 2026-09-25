// Direct OTA protocol v1. Standard ES256 JWS; keys are supplied by the native binary.
import Foundation
import CryptoKit

struct DirectOtaArtifact: Codable {
    let path: String, url: String, sha256: String, checksum: String, sessionKey: String
    let bytes: Int, unpackedBytes: Int, files: Int
}
struct DirectOtaLimits {
    let archiveBytes: Int, unpackedBytes: Int, files: Int
    var valid: Bool { (5242880...52428800).contains(archiveBytes) && (26214400...104857600).contains(unpackedBytes) && (1000...5000).contains(files) && unpackedBytes >= archiveBytes }
}
struct DirectOtaManifest: Codable {
    let protocolVersion: Int
    let appId: String, environment: String, platform: String, channel: String, runtime: String
    let sequence: Int64, backendContract: Int, rollout: Int
    let action: String, releaseId: String, version: String, issuedAt: String
    let mode: String?
    let artifact: DirectOtaArtifact?
    enum CodingKeys: String, CodingKey { case protocolVersion = "protocol", appId, environment, platform, channel, runtime, sequence, backendContract, rollout, action, releaseId, version, issuedAt, mode, artifact }
}
enum DirectOtaFailure: String, Error { case invalid = "OTA_INVALID", network = "OTA_NETWORK", paused = "OTA_PAUSED", storage = "OTA_STORAGE", replay = "OTA_REPLAY", quarantined = "OTA_QUARANTINED", busy = "OTA_BUSY" }
enum DirectOtaProtocol {
    static func base64url(_ value: String) throws -> Data {
        guard !value.isEmpty, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw DirectOtaFailure.invalid }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: padded),
              data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value else { throw DirectOtaFailure.invalid }
        return data
    }
    static func verify(_ jws: String, keyId: String, x: String, y: String, appId: String, environment: String, artifactBaseUrl: String, backendContract: Int, runtime: String, channel: String, platform: String = "ios", limits: DirectOtaLimits = DirectOtaLimits(archiveBytes: 5242880, unpackedBytes: 26214400, files: 1000)) throws -> DirectOtaManifest {
        guard limits.valid else { throw DirectOtaFailure.invalid }
        guard jws.utf8.count <= 8192 else { throw DirectOtaFailure.invalid }
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3 else { throw DirectOtaFailure.invalid }
        let header = try JSONSerialization.jsonObject(with: base64url(parts[0])) as? [String: String]
        guard header?.count == 3, header?["alg"] == "ES256", header?["typ"] == "DIRECT-OTA", header?["kid"] == keyId else { throw DirectOtaFailure.invalid }
        guard (try base64url(x)).count == 32, (try base64url(y)).count == 32 else { throw DirectOtaFailure.invalid }
        var raw = Data([4]); raw.append(try base64url(x)); raw.append(try base64url(y))
        let key = try P256.Signing.PublicKey(x963Representation: raw)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: base64url(parts[2]))
        guard key.isValidSignature(signature, for: Data((parts[0] + "." + parts[1]).utf8)) else { throw DirectOtaFailure.invalid }
        let payload = try base64url(parts[1])
        guard let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else { throw DirectOtaFailure.invalid }
        let common: Set<String> = ["protocol", "appId", "environment", "platform", "channel", "runtime", "sequence", "backendContract", "rollout", "action", "releaseId", "version", "issuedAt"]
        let action = object["action"] as? String
        guard Set(object.keys) == (action == "release" ? common.union(object["mode"] == nil ? ["artifact"] : ["artifact", "mode"]) : common) else { throw DirectOtaFailure.invalid }
        if action == "release" {
            guard let artifact = object["artifact"] as? [String: Any], Set(artifact.keys) == ["path", "url", "sha256", "bytes", "unpackedBytes", "files", "checksum", "sessionKey"] else { throw DirectOtaFailure.invalid }
        }
        let m = try JSONDecoder().decode(DirectOtaManifest.self, from: payload)
        let timestampPattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$"
        let dates = ISO8601DateFormatter(); dates.formatOptions = [.withInternetDateTime]
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let dateFormatter = m.issuedAt.contains(".") ? fractional : dates
        guard m.issuedAt.range(of: timestampPattern, options: .regularExpression) != nil,
              let issued = dateFormatter.date(from: m.issuedAt),
              dateFormatter.string(from: issued) == m.issuedAt,
              issued.timeIntervalSinceNow <= 300 else { throw DirectOtaFailure.invalid }
        guard m.protocolVersion == 1, m.appId == appId, m.environment == environment, m.platform == platform,
              m.channel == channel, ["production", "internal"].contains(channel), m.runtime == runtime,
              runtime.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              m.backendContract == backendContract, m.sequence > 0, m.sequence <= 9007199254740991, (0...100).contains(m.rollout),
              m.releaseId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil, m.version.count <= 64,
              m.version.range(of: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$", options: .regularExpression) != nil
        else { throw DirectOtaFailure.invalid }
        if m.action == "withdraw" { guard m.artifact == nil, m.mode == nil else { throw DirectOtaFailure.invalid }; return m }
        guard m.mode == nil || m.mode == "required" || m.mode == "background" else { throw DirectOtaFailure.invalid }
        guard m.action == "release", let a = m.artifact, a.bytes > 0, a.bytes <= limits.archiveBytes,
              a.unpackedBytes > 0, a.unpackedBytes <= limits.unpackedBytes, (1...limits.files).contains(a.files),
              a.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw DirectOtaFailure.invalid }
        let p = a.path.split(separator: "/").map(String.init)
        guard p.count == 4, p[0] == platform, p[1] == runtime,
              p[2].range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
              p[3] == a.sha256 + ".zip",
              a.url == artifactBaseUrl + "/" + a.path else { throw DirectOtaFailure.invalid }
        let session = a.sessionKey.split(separator: ":").map(String.init)
        guard session.count == 2, Data(base64Encoded: session[0])?.count == 16, Data(base64Encoded: session[1])?.count == 256,
              a.checksum.range(of: "^[0-9a-f]{512}$", options: .regularExpression) != nil || Data(base64Encoded: a.checksum)?.count == 256 else { throw DirectOtaFailure.invalid }
        return m
    }
    static func validRange(_ value: String?, offset: Int, total: Int) -> Bool {
        value == "bytes \(offset)-\(total - 1)/\(total)"
    }
    static func safeEntry(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return !path.isEmpty && path.utf8.count <= 1024 && parts.count <= 32 &&
            Array(path.utf8) == Array(path.precomposedStringWithCanonicalMapping.utf8) &&
            !path.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) }) &&
            !path.hasPrefix("/") && !path.contains("\\") && !path.contains(":") &&
            !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
    }
    static func cohort(_ installation: String) -> Int {
        let hash = Data(SHA256.hash(data: Data(installation.utf8)))
        return (Int(hash[0]) * 256 + Int(hash[1])) % 10000
    }
}
