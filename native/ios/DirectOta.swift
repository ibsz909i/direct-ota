// Direct OTA integration for the pinned MPL-2.0 Capgo updater.
import Foundation
import Capacitor
import CryptoKit
import Network
import UIKit
import ZIPFoundation

final class DirectOtaController {
    var requiresVerifiedApi: Bool { true }
    private weak var host: CapacitorUpdaterPlugin?
    private let monitor = NWPathMonitor()
    private var connection = "unknown"
    private var transfer: DirectOtaTransfer?
    private var token: String?
    private var manifest: DirectOtaManifest?
    private var phase = "idle"
    private var error: String?
    private var received = 0
    private var readyTimer: Timer?
    private var activeSeconds = 0.0
    private var lastTick = ProcessInfo.processInfo.systemUptime
    private var readyCheck: (() -> Void)?
    private var activationInProgress = false
    private var importing = false
    private var generation = 0
    private var watchedBundle: String?
    private let defaults = UserDefaults.standard
    private var key: String { "direct-ota." + runtime + "." + channel }
    var runtime: String { host?.getConfig().getString("directOtaRuntime", "") ?? "" }
    var channel: String { host?.getConfig().getString("directOtaChannel", "") ?? "" }
    private var appId: String { host?.getConfig().getString("directOtaAppId", "") ?? "" }
    private var environment: String { host?.getConfig().getString("directOtaEnvironment", "") ?? "" }
    private var artifactBaseUrl: String { host?.getConfig().getString("directOtaArtifactBaseUrl", "") ?? "" }
    private var backendContract: Int { host?.getConfig().getInt("directOtaBackendContract", 0) ?? 0 }
    private var limits: DirectOtaLimits { DirectOtaLimits(
        archiveBytes: host?.getConfig().getInt("directOtaMaxArchiveBytes", 5242880) ?? 5242880,
        unpackedBytes: host?.getConfig().getInt("directOtaMaxUnpackedBytes", 26214400) ?? 26214400,
        files: host?.getConfig().getInt("directOtaMaxFiles", 1000) ?? 1000) }
    var enabled: Bool {
        guard runtime.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              ["internal", "production"].contains(channel),
              appId.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
              environment.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil,
              backendContract > 0, limits.valid, let url = URL(string: artifactBaseUrl),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.absoluteString == artifactBaseUrl,
              url.path.range(of: "^/[A-Za-z0-9/_-]*$", options: .regularExpression) != nil,
              !artifactBaseUrl.hasSuffix("/") else { return false }
        let keyId = host?.getConfig().getString("directOtaKeyId", "") ?? ""
        let x = host?.getConfig().getString("directOtaKeyX", "") ?? ""
        let y = host?.getConfig().getString("directOtaKeyY", "") ?? ""
        let ring = host?.getConfig().getString("directOtaTrustedKeys", "") ?? ""
        return (try? DirectOtaProtocol.signingKeys(ring, keyId: keyId, x: x, y: y)) != nil
    }
    private var folder: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("direct-ota") }
    private var installation: String {
        if let value = defaults.string(forKey: "direct-ota.installation") { return value }
        let value = UUID().uuidString.lowercased(); defaults.set(value, forKey: "direct-ota.installation"); return value
    }
    init(_ host: CapacitorUpdaterPlugin) {
        self.host = host
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                self.connection = path.status != .satisfied ? "offline" : path.usesInterfaceType(.wifi) && !path.isExpensive && !path.isConstrained ? "wifi" : "cellular"
                if let transfer = self.transfer, self.connection == "offline" || (self.connection != "wifi" && !transfer.cellular) { self.pause() }
                self.emit()
            }
        }
        monitor.start(queue: DispatchQueue(label: "direct-ota.network"))
        if let saved = defaults.string(forKey: key + ".manifest"), let parsed = try? verify(saved),
           let epoch = try? signingEpoch(saved), epoch >= defaults.integer(forKey: key + ".keyEpoch") {
            token = saved; manifest = parsed
        }
    }
    deinit { monitor.cancel(); transfer?.cancel(); readyTimer?.invalidate() }
    private func verify(_ value: String) throws -> DirectOtaManifest {
        guard let host, enabled else { throw DirectOtaFailure.invalid }
        return try DirectOtaProtocol.verify(value, keyId: host.getConfig().getString("directOtaKeyId", "") ?? "", x: host.getConfig().getString("directOtaKeyX", "") ?? "", y: host.getConfig().getString("directOtaKeyY", "") ?? "", appId: appId, environment: environment, artifactBaseUrl: artifactBaseUrl, backendContract: backendContract, runtime: runtime, channel: channel, limits: limits, trustedKeysJSON: host.getConfig().getString("directOtaTrustedKeys", "") ?? "")
    }
    private func signingEpoch(_ value: String) throws -> Int {
        guard let host else { throw DirectOtaFailure.invalid }
        let keys = try DirectOtaProtocol.signingKeys(host.getConfig().getString("directOtaTrustedKeys", "") ?? "", keyId: host.getConfig().getString("directOtaKeyId", "") ?? "", x: host.getConfig().getString("directOtaKeyX", "") ?? "", y: host.getConfig().getString("directOtaKeyY", "") ?? "")
        return try DirectOtaProtocol.signerIndex(value, keys: keys)
    }
    private func bundleId(_ hash: String) -> String { "do" + String(hash.prefix(30)) }
    private var quarantine: [String] { defaults.stringArray(forKey: key + ".quarantine") ?? [] }
    private func imported(_ hash: String) -> Bool {
        guard defaults.bool(forKey: key + ".verified." + hash), let host,
              let directory = try? host.implementation.getBundleDirectory(id: bundleId(hash)) else { return false }
        return FileManager.default.fileExists(atPath: directory.appendingPathComponent("index.html").path)
    }
    private func clearRequirement() {
        generation += 1; pause(); token = nil; manifest = nil; phase = "idle"; error = nil; save(); emit()
    }
    private func save() { defaults.set(token, forKey: key + ".manifest"); defaults.synchronize() }
    private func recover() {
        guard let a = manifest?.artifact, let host else { return }
        let info = host.implementation.getBundleInfo(id: bundleId(a.sha256))
        if info.isErrorStatus() || quarantine.contains(a.sha256) {
            defaults.set(Array(Set(quarantine + [a.sha256])).sorted(), forKey: key + ".quarantine")
            token = nil; manifest = nil; phase = "idle"; error = nil; save()
        } else if host.implementation.getCurrentBundleId() == bundleId(a.sha256) && info.getStatus() == BundleStatus.SUCCESS.storedValue {
            token = nil; manifest = nil; phase = "idle"; error = nil; save()
        }
    }
    func state() -> JSObject {
        recover()
        let current = host?.implementation.getCurrentBundleId() ?? "builtin"
        var output: JSObject = ["enabled": enabled, "platform": "ios", "runtime": runtime, "channel": channel, "connection": connection, "phase": phase, "received": received, "installationId": installation, "current": current]
        if let token, let m = manifest { output["manifest"] = token; output["total"] = m.artifact?.bytes ?? 0; output["version"] = m.version; output["releaseId"] = m.releaseId; output["mode"] = m.mode ?? "required"; output["cellularAllowed"] = defaults.bool(forKey: key + ".cellular." + (m.artifact?.sha256 ?? "")) }
        if let error { output["error"] = error }
        return output
    }
    private func emit() { host?.notifyListeners("otaStateChange", data: state()) }
    func accept(_ value: String) throws {
        let m = try verify(value)
        let epoch = try signingEpoch(value)
        guard epoch >= defaults.integer(forKey: key + ".keyEpoch") else { throw DirectOtaFailure.replay }
        let highest = Int64(defaults.string(forKey: key + ".sequence") ?? "0") ?? 0
        guard m.sequence >= highest else { throw DirectOtaFailure.replay }
        if m.sequence == highest, let old = defaults.string(forKey: key + ".latest"), old != value { throw DirectOtaFailure.replay }
        // A malformed, incompatible or unsigned response can never introduce a required update.
        defaults.set(String(m.sequence), forKey: key + ".sequence")
        defaults.set(value, forKey: key + ".latest")
        defaults.set(epoch, forKey: key + ".keyEpoch")
        defaults.synchronize()
        if m.action == "withdraw" { clearRequirement(); return }
        guard let a = m.artifact else { throw DirectOtaFailure.invalid }
        if quarantine.contains(a.sha256) { throw DirectOtaFailure.quarantined }
        // An existing required update stays required until a signed withdrawal or replacement.
        if DirectOtaProtocol.cohort(installation) >= m.rollout * 100 && manifest == nil { defaults.synchronize(); return }
        if host?.implementation.getCurrentBundleId() == bundleId(a.sha256) { clearRequirement(); return }
        if token != value { generation += 1; pause(); received = 0; phase = "required"; error = nil }
        token = value; manifest = m; save(); emit()
    }
    func pause() { transfer?.cancel(); if transfer != nil { phase = "paused" }; emit() }
    func download(cellular: Bool, completion: @escaping (Error?) -> Void) {
        guard transfer == nil, !importing, !activationInProgress else { completion(DirectOtaFailure.busy); return }
        guard let m = manifest, let a = m.artifact, let host else { completion(DirectOtaFailure.invalid); return }
        let consentKey = key + ".cellular." + a.sha256
        if cellular && m.mode == "background" { completion(DirectOtaFailure.paused); return }
        if cellular { defaults.set(true, forKey: consentKey) }
        let allowed = m.mode != "background" && defaults.bool(forKey: consentKey)
        guard connection != "offline", connection != "unknown", allowed || connection == "wifi" else { phase = connection == "offline" ? "paused" : "wifi"; emit(); completion(DirectOtaFailure.paused); return }
        if imported(a.sha256) && !host.implementation.getBundleInfo(id: bundleId(a.sha256)).isErrorStatus() { phase = "ready"; emit(); completion(nil); return }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            for stale in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                if stale.lastPathComponent.range(of: "^[0-9a-f]{64}\\.(part|zip)$", options: .regularExpression) != nil && !stale.lastPathComponent.hasPrefix(a.sha256 + ".") { try? FileManager.default.removeItem(at: stale) }
            }
            var directory = folder; var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
            let space = try folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
            guard space > Int64(a.unpackedBytes + a.bytes * 3 + 10485760) else { throw DirectOtaFailure.storage }
            let path = folder.appendingPathComponent(a.sha256 + ".part")
            let operation = generation
            phase = "downloading"; error = nil
            let downloader = DirectOtaTransfer(url: URL(string: a.url)!, path: path, total: a.bytes, cellular: allowed, progress: { [weak self] bytes in
                DispatchQueue.main.async { guard let self, self.generation == operation else { return }; self.received = bytes; self.emit() }
            }) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { completion(DirectOtaFailure.paused); return }
                    self.transfer = nil
                    guard self.generation == operation else { completion(DirectOtaFailure.paused); return }
                    switch result {
                    case .failure(let failure): self.phase = "paused"; self.error = (failure as? DirectOtaFailure)?.rawValue ?? "OTA_NETWORK"; self.emit(); completion(failure)
                    case .success:
                        guard self.manifest?.artifact?.sha256 == a.sha256 else { completion(DirectOtaFailure.paused); return }
                        self.importing = true; self.phase = "verifying"; self.emit()
                        DispatchQueue.global(qos: .utility).async {
                            do {
                                try self.importArchive(path, manifest: m, host: host)
                                DispatchQueue.main.async {
                                    self.importing = false
                                    guard self.generation == operation, self.manifest?.artifact?.sha256 == a.sha256 else { completion(DirectOtaFailure.paused); return }
                                    self.defaults.set(true, forKey: self.key + ".verified." + a.sha256)
                                    self.phase = "ready"; self.emit(); completion(nil)
                                }
                            } catch {
                                DispatchQueue.main.async {
                                    self.importing = false
                                    guard self.generation == operation else { completion(DirectOtaFailure.paused); return }
                                    self.phase = "error"; self.error = (error as? DirectOtaFailure)?.rawValue ?? "OTA_INVALID"; self.emit(); completion(error)
                                }
                            }
                        }
                    }
                }
            }
            transfer = downloader; emit(); downloader.start()
        } catch { phase = "error"; self.error = (error as? DirectOtaFailure)?.rawValue ?? "OTA_STORAGE"; emit(); completion(error) }
    }
    private func importArchive(_ encrypted: URL, manifest m: DirectOtaManifest, host: CapacitorUpdaterPlugin) throws {
        guard let a = m.artifact else { throw DirectOtaFailure.invalid }
        guard CryptoCipher.calcChecksum(filePath: encrypted) == a.sha256 else { try? FileManager.default.removeItem(at: encrypted); throw DirectOtaFailure.invalid }
        let zip = folder.appendingPathComponent(a.sha256 + ".zip")
        try? FileManager.default.removeItem(at: zip); try FileManager.default.copyItem(at: encrypted, to: zip)
        defer { try? FileManager.default.removeItem(at: zip) }
        try CryptoCipher.decryptFile(filePath: zip, publicKey: host.implementation.publicKey, sessionKey: a.sessionKey, version: m.version)
        let checksum = try CryptoCipher.decryptChecksum(checksum: a.checksum, publicKey: host.implementation.publicKey)
        guard checksum.count == 64, checksum == CryptoCipher.calcChecksum(filePath: zip) else { throw DirectOtaFailure.invalid }
        let archive = try Archive(url: zip, accessMode: .read)
        var count = 0, size: UInt64 = 0
        var names = Set<String>()
        for entry in archive {
            count += 1; size += UInt64(entry.uncompressedSize)
            guard count <= limits.files, size <= UInt64(a.unpackedBytes), size <= UInt64(limits.unpackedBytes), entry.type == .file,
                  DirectOtaProtocol.safeEntry(entry.path), names.insert(entry.path).inserted else { throw DirectOtaFailure.invalid }
        }
        guard count == a.files, size == UInt64(a.unpackedBytes), names.contains("index.html") else { throw DirectOtaFailure.invalid }
        try host.implementation.directOtaImport(zip: zip, id: bundleId(a.sha256), version: m.version, checksum: checksum)
        try? FileManager.default.removeItem(at: encrypted)
    }
    func mayActivate(_ id: String) -> Bool { guard let a = manifest?.artifact else { return false }; return id == bundleId(a.sha256) && imported(a.sha256) && !quarantine.contains(a.sha256) }
    func activate() throws {
        guard let host, let a = manifest?.artifact, transfer == nil, !importing, phase == "ready", mayActivate(bundleId(a.sha256)) else { throw DirectOtaFailure.invalid }
        activationInProgress = true; phase = "installing"; emit()
        guard host.implementation.set(id: bundleId(a.sha256)), host.reloadWithoutWaitingForAppReady() else { activationInProgress = false; throw DirectOtaFailure.invalid }
    }
    func markReady() {
        readyTimer?.invalidate(); readyTimer = nil; readyCheck = nil; watchedBundle = nil; activeSeconds = 0; activationInProgress = false
        defaults.removeObject(forKey: key + ".launch")
        guard let host else { return }
        let id = host.implementation.getCurrentBundleId()
        var successful = defaults.stringArray(forKey: key + ".successful") ?? []
        successful.removeAll { $0 == id }; if id != "builtin" { successful.append(id) }
        let obsolete = Array(successful.dropLast(2)); successful = Array(successful.suffix(2))
        defaults.set(successful, forKey: key + ".successful")
        for old in obsolete where old != id && !mayActivate(old) { _ = host.implementation.delete(id: old) }
        recover(); emit()
    }
    func watchReady(_ check: @escaping () -> Void) {
        guard let current = host?.implementation.getCurrentBundle(), !current.isBuiltin(), current.getStatus() != BundleStatus.SUCCESS.storedValue else { return }
        let id = current.getId()
        if watchedBundle == id, readyTimer != nil { return }
        readyTimer?.invalidate()
        if watchedBundle != id {
            // A process exit before readiness rolls back on the next launch.
            if defaults.string(forKey: key + ".launch") == id {
                defaults.removeObject(forKey: key + ".launch"); check(); return
            }
            activeSeconds = 0; watchedBundle = id
            defaults.set(id, forKey: key + ".launch"); defaults.synchronize()
        }
        lastTick = ProcessInfo.processInfo.systemUptime; readyCheck = check
        readyTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if UIApplication.shared.applicationState == .active { self.activeSeconds += min(now - self.lastTick, 1) }
            self.lastTick = now
            if self.activeSeconds >= 30 {
                self.readyTimer?.invalidate(); self.readyTimer = nil
                self.defaults.removeObject(forKey: self.key + ".launch")
                let callback = self.readyCheck; self.readyCheck = nil; callback?()
            }
        }
    }
}

// Stream directly to an encrypted partial file. The URL is already bound by a signed manifest.
final class DirectOtaTransfer: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    let cellular: Bool
    private let url: URL, path: URL
    private let total: Int
    private var bytes = 0, lastEmission = 0
    private var lastEmissionTime = ProcessInfo.processInfo.systemUptime
    private var handle: FileHandle?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var failure: Error?
    private let progress: (Int) -> Void
    private let completion: (Result<Void, Error>) -> Void
    init(url: URL, path: URL, total: Int, cellular: Bool, progress: @escaping (Int) -> Void, completion: @escaping (Result<Void, Error>) -> Void) {
        self.url = url; self.path = path; self.total = total; self.cellular = cellular; self.progress = progress; self.completion = completion
    }
    func start() {
        do {
            if !FileManager.default.fileExists(atPath: path.path) { FileManager.default.createFile(atPath: path.path, contents: Data()) }
            handle = try FileHandle(forUpdating: path); bytes = Int(try handle!.seekToEnd())
            if bytes > total { try handle?.truncate(atOffset: 0); bytes = 0 }
            if bytes == total { try handle?.close(); handle = nil; completion(.success(())); return }
            progress(bytes)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.allowsCellularAccess = cellular; configuration.allowsExpensiveNetworkAccess = cellular; configuration.allowsConstrainedNetworkAccess = cellular
            configuration.waitsForConnectivity = false; configuration.timeoutIntervalForRequest = 45; configuration.timeoutIntervalForResource = 604800
            let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
            session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
            var request = URLRequest(url: url); request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            if bytes > 0 { request.setValue("bytes=\(bytes)-", forHTTPHeaderField: "Range") }
            task = session?.dataTask(with: request); task?.resume()
        } catch { completion(.failure(DirectOtaFailure.storage)) }
    }
    func cancel() { task?.cancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { failure = DirectOtaFailure.invalid; completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else { failure = DirectOtaFailure.network; completionHandler(.cancel); return }
        do {
            if http.statusCode == 200 { try handle?.truncate(atOffset: 0); try handle?.seek(toOffset: 0); bytes = 0 }
            else if http.statusCode != 206 || !DirectOtaProtocol.validRange(http.value(forHTTPHeaderField: "Content-Range"), offset: bytes, total: total) { throw DirectOtaFailure.network }
            if response.expectedContentLength >= 0 && response.expectedContentLength != Int64(total - bytes) { throw DirectOtaFailure.invalid }
            completionHandler(.allow)
        } catch { failure = error; completionHandler(.cancel) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        do {
            guard bytes + data.count <= total else { throw DirectOtaFailure.invalid }
            try handle?.write(contentsOf: data); bytes += data.count
            let now = ProcessInfo.processInfo.systemUptime
            if bytes - lastEmission >= 32768 || now - lastEmissionTime >= 1 || bytes == total { try handle?.synchronize(); lastEmission = bytes; lastEmissionTime = now; progress(bytes) }
        } catch { failure = error; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? handle?.synchronize(); try? handle?.close(); handle = nil
        session.finishTasksAndInvalidate(); self.session = nil; self.task = nil
        if failure == nil, let error = error as NSError?, error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { completion(.failure(DirectOtaFailure.paused)) }
        else if let failure = failure ?? error { completion(.failure(failure)) }
        else if bytes != total { completion(.failure(DirectOtaFailure.network)) }
        else { progress(bytes); completion(.success(())) }
    }
}
