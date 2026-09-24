import Foundation

// Minimal logging and error types needed to compile the pinned upstream cipher
// on macOS. The crypto implementation itself is linked directly from Capgo.
public final class Logger {
    public init() {}
    public func info(_ message: String) {}
    public func error(_ message: String) {}
    public func debug(_ message: String) {}
}
enum CustomError: Error { case cannotDecode }

let encrypted = URL(fileURLWithPath: CommandLine.arguments[1])
let publicKey = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let checksum = CommandLine.arguments[3]
let sessionKey = CommandLine.arguments[4]
let expected = CommandLine.arguments[5]
CryptoCipher.setLogger(Logger())
guard publicKey.hasPrefix("-----BEGIN RSA PUBLIC KEY-----") else { fatalError("Capgo key format") }
guard try CryptoCipher.decryptChecksum(checksum: checksum, publicKey: publicKey) == expected else { fatalError("checksum recovery") }
try CryptoCipher.decryptFile(filePath: encrypted, publicKey: publicKey, sessionKey: sessionKey, version: "1.2.3-beta.1+build.4")
guard CryptoCipher.calcChecksum(filePath: encrypted) == expected else { fatalError("session key or AES recovery") }
print("Upstream Capgo checksum and session decryption passed")
