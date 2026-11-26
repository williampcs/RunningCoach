import Capacitor
import UIKit

/// App 的主畫面：Capacitor 的 WebView，多註冊試做用的外掛（規格 12.49）。
/// 搖一搖打開 App 內的測試頁（ios-probe.html），網頁版的程式不用改。
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthProbePlugin())
    }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake, let base = bridge?.config.serverURL else { return }
        webView?.load(URLRequest(url: base.appendingPathComponent("ios-probe.html")))
    }
}
