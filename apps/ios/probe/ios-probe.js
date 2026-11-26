// App 測試頁（規格 12.49）：只輸出統計與能力，不輸出 Apple 健康的實際數值
(function () {
  "use strict";
  var cfg = window.IOS_PROBE_CONFIG || {};
  var results = {};
  var $ = function (id) { return document.getElementById(id); };
  var show = function (key, value) {
    results[key] = value;
    $(key + "-out").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  };
  var errText = function (e) { return e && e.name ? e.name + ": " + e.message : String(e); };
  var native = function (plugin, method, options) {
    var cap = window.Capacitor;
    if (!cap || !cap.nativePromise) return Promise.reject(new Error("不在 App 裡（沒有 Capacitor）"));
    return cap.nativePromise(plugin, method, options || {});
  };

  function workerCheck() {
    // OPFS 的同步存取只在 Worker 裡有（App 的資料庫用的就是這個）
    var src = "onmessage=async()=>{try{const d=await navigator.storage.getDirectory();const f=await d.getFileHandle('probe-sync.bin',{create:true});const h=await f.createSyncAccessHandle();h.write(new Uint8Array([1,2,3]),{at:0});h.flush();const n=h.getSize();h.close();postMessage('ok size='+n)}catch(e){postMessage('fail '+e.name+': '+e.message)}}";
    return new Promise(function (resolve) {
      try {
        var w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        w.onmessage = function (m) { resolve(m.data); w.terminate(); };
        w.onerror = function (e) { resolve("worker error " + (e.message || "")); };
        w.postMessage(1);
        setTimeout(function () { resolve("timeout"); }, 5000);
      } catch (e) { resolve("fail " + errText(e)); }
    });
  }

  $("env").onclick = async function () {
    var out = {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      userAgent: navigator.userAgent.replace(/\([^)]*\)/, function (m) { return m.replace(/; [^;]*$/, ""); }),
      capacitor: !!window.Capacitor,
      cryptoSubtle: !!(window.crypto && crypto.subtle),
      storageGetDirectory: !!(navigator.storage && navigator.storage.getDirectory),
      webLocks: !!navigator.locks,
      broadcastChannel: typeof BroadcastChannel === "function",
      publicKeyCredential: typeof PublicKeyCredential === "function",
    };
    try { out.persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : "n/a"; } catch (e) { out.persisted = errText(e); }
    try { out.persist = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : "n/a"; } catch (e) { out.persist = errText(e); }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        out.quotaMB = Math.round((est.quota || 0) / 1048576);
      }
    } catch (e) { out.quotaMB = errText(e); }
    out.opfsSyncAccessInWorker = await workerCheck();
    if (out.publicKeyCredential) {
      try { out.platformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { out.platformAuthenticator = errText(e); }
      try { out.clientCapabilities = PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : "n/a"; } catch (e) { out.clientCapabilities = errText(e); }
    }
    show("env", out);
  };

  $("opfs").onclick = async function () {
    try {
      var dir = await navigator.storage.getDirectory();
      var file = await dir.getFileHandle("probe-counter.txt", { create: true });
      var text = await (await file.getFile()).text();
      var n = (parseInt(text, 10) || 0) + 1;
      var w = await file.createWritable();
      await w.write(String(n));
      await w.close();
      // App 的資料庫（SQLite 的 OPFS 檔案池）在不在：只列名稱，不讀內容
      var entries = [];
      for await (var entry of dir.values()) entries.push(entry.kind === "directory" ? entry.name + "/" : entry.name);
      show("opfs", { count: "第 " + n + " 次（上一次是 " + (n - 1) + "）", opfsRoot: entries.sort() });
    } catch (e) { show("opfs", "失敗 " + errText(e)); }
  };

  $("hk-ask").onclick = function () {
    native("HealthProbe", "requestAccess").then(function (r) { show("hk", r); }, function (e) { show("hk", "失敗 " + errText(e)); });
  };
  $("hk-sum").onclick = function () {
    show("hk", "讀取中…");
    native("HealthProbe", "summary").then(function (r) { show("hk", r); }, function (e) { show("hk", "失敗 " + errText(e)); });
  };

  async function viaFetch(url, init) {
    try {
      var r = await fetch(url, init);
      return "status " + r.status + "（瀏覽器讀得到回應：沒有被 CORS 擋）";
    } catch (e) { return "被擋或連不上：" + errText(e); }
  }
  async function viaNative(url, method) {
    try {
      var r = await native("CapacitorHttp", "request", { url: url, method: method, headers: { "content-type": "application/json" }, data: method === "POST" ? {} : undefined });
      return "status " + r.status + "（原生的 HTTP，不經過 CORS）";
    } catch (e) { return "失敗：" + errText(e); }
  }

  $("cors").onclick = async function () {
    show("cors", "測試中…");
    var out = { origin: location.origin };
    var targets = [];
    if (cfg.syncUrl) targets.push(["sync", cfg.syncUrl.replace(/\/+$/, "") + "/v1/spaces/probe-does-not-exist", "GET"]);
    if (cfg.proxyUrl) targets.push(["proxy", cfg.proxyUrl.replace(/\/+$/, "") + "/v1/usage", "GET"]);
    if (!targets.length) out.note = "這次建置沒有設定同步服務或代理的網址（app.env.local）";
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      out[t[0] + "Fetch"] = await viaFetch(t[1], { method: t[2] });
      out[t[0] + "Native"] = await viaNative(t[1], t[2]);
    }
    show("cors", out);
  };

  // #auto：模擬器用，自動跑不需要權限的幾項（不含 Apple 健康）
  if (location.hash === "#auto") {
    setTimeout(async function () {
      await $("env").onclick();
      await $("opfs").onclick();
      await $("cors").onclick();
      // 只有能力與連線的結果，沒有健康資料；Capacitor 會把它轉到 Xcode 的 log
      console.log("IOS_PROBE " + JSON.stringify(results));
    }, 300);
  }

  $("copy").onclick = async function () {
    var text = "App 測試頁的結果（規格 12.49）\n" + JSON.stringify(results, null, 2);
    try { await navigator.clipboard.writeText(text); $("copied").textContent = "已複製"; }
    catch (e) { $("copied").textContent = "複製失敗：" + errText(e); }
  };
})();
