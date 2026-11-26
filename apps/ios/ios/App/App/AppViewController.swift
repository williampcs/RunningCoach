import Capacitor
import UIKit

/// App 的主畫面：Capacitor 的 WebView，多註冊試做用的外掛（規格 12.49）。
/// 搖一搖打開 App 內的測試頁（ios-probe.html），網頁版的程式不用改。
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthProbePlugin())
    }

    /// 模擬器裡沒辦法搖：用啟動參數 -probe 直接打開測試頁並自動跑（xcrun simctl launch … -probe）
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard ProcessInfo.processInfo.arguments.contains("-probe"), !openedProbe, let base = bridge?.config.serverURL else { return }
        openedProbe = true
        webView?.load(URLRequest(url: URL(string: base.absoluteString + "/ios-probe.html#auto")!))
    }

    private var openedProbe = false

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake, let base = bridge?.config.serverURL else { return }
        webView?.load(URLRequest(url: base.appendingPathComponent("ios-probe.html")))
    }
}
