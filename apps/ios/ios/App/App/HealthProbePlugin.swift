import Capacitor
import HealthKit

/// 試做用（規格 12.49）：讀 Apple 健康，只回傳統計（有沒有、筆數、每分鐘幾筆、欄位名稱、來源的種類）。
/// 不回傳任何實際的數值（日期、距離、心率、路線的座標），可以整個丟掉。
@objc(HealthProbePlugin)
public class HealthProbePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthProbePlugin"
    public let jsName = "HealthProbe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "summary", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()

    private var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.distanceCycling),
            HKQuantityType(.stepCount),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.restingHeartRate),
            HKQuantityType(.heartRateVariabilitySDNN),
            HKQuantityType(.vo2Max),
            HKCategoryType(.sleepAnalysis)
        ]
        if #available(iOS 16.0, *) {
            types.formUnion([
                HKQuantityType(.runningSpeed),
                HKQuantityType(.runningPower),
                HKQuantityType(.runningStrideLength),
                HKQuantityType(.runningVerticalOscillation),
                HKQuantityType(.runningGroundContactTime)
            ])
        }
        return types
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["available": false])
            return
        }
        store.requestAuthorization(toShare: nil, read: readTypes) { ok, error in
            call.resolve([
                "available": true,
                "requested": ok,
                "error": error.map { String(describing: type(of: $0)) + ": " + $0.localizedDescription } ?? ""
            ])
        }
    }

    @objc func summary(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["available": false])
            return
        }
        Task {
            do {
                call.resolve(try await self.buildSummary())
            } catch {
                call.reject(String(describing: type(of: error)) + ": " + error.localizedDescription)
            }
        }
    }

    // MARK: - 統計

    private func buildSummary() async throws -> [String: Any] {
        let now = Date()
        let since = Calendar.current.date(byAdding: .day, value: -180, to: now) ?? now
        let workouts = try await samples(HKObjectType.workoutType(), from: since, to: now, limit: 1000)
            .compactMap { $0 as? HKWorkout }
            .sorted { $0.startDate > $1.startDate }

        var byType: [String: Int] = [:]
        var bySource: [String: Int] = [:]
        for workout in workouts {
            byType[activityName(workout.workoutActivityType), default: 0] += 1
            bySource[sourceKind(workout.sourceRevision), default: 0] += 1
        }

        let runs = Array(workouts.filter { $0.workoutActivityType == .running }.prefix(20))
        var runStats = RunStats()
        for run in runs {
            try await runStats.add(run, probe: self)
        }

        let monthAgo = Calendar.current.date(byAdding: .day, value: -30, to: now) ?? now
        var daily: [String: Int] = [:]
        for (name, type) in [
            ("restingHeartRate", HKQuantityType(.restingHeartRate) as HKSampleType),
            ("heartRateVariabilitySDNN", HKQuantityType(.heartRateVariabilitySDNN)),
            ("vo2Max", HKQuantityType(.vo2Max)),
            ("sleepAnalysis", HKCategoryType(.sleepAnalysis))
        ] {
            daily[name] = try await samples(type, from: monthAgo, to: now, limit: 5000).count
        }

        return [
            "available": true,
            "note": "HealthKit 不告訴 App 讀取權限有沒有被拒絕：被拒絕時看起來就是 0 筆",
            "workoutsLast180Days": workouts.count,
            "workoutsByType": byType,
            "workoutsBySource": bySource,
            "running": runStats.result(),
            "samplesLast30Days": daily
        ]
    }

    fileprivate func samples(_ type: HKSampleType, from start: Date, to end: Date, limit: Int) async throws -> [HKSample] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        return try await query(type, predicate: predicate, limit: limit)
    }

    fileprivate func query(_ type: HKSampleType, predicate: NSPredicate, limit: Int) async throws -> [HKSample] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit, sortDescriptors: nil) { _, results, error in
                if let error = error as? HKError, error.code == .errorNoData {
                    continuation.resume(returning: [])
                } else if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: results ?? [])
                }
            }
            store.execute(query)
        }
    }

    /// 一條路線有幾個點（不讀座標）
    fileprivate func routePointCount(_ route: HKWorkoutRoute) async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            var count = 0
            var finished = false
            let query = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                if finished { return }
                if let error {
                    finished = true
                    continuation.resume(throwing: error)
                    return
                }
                count += locations?.count ?? 0
                if done {
                    finished = true
                    continuation.resume(returning: count)
                }
            }
            store.execute(query)
        }
    }

    // MARK: - 名稱

    private func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "running"
        case .walking: return "walking"
        case .cycling: return "cycling"
        case .hiking: return "hiking"
        case .swimming: return "swimming"
        case .traditionalStrengthTraining: return "traditionalStrengthTraining"
        case .functionalStrengthTraining: return "functionalStrengthTraining"
        case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
        case .crossTraining: return "crossTraining"
        case .coreTraining: return "coreTraining"
        case .yoga: return "yoga"
        case .pilates: return "pilates"
        case .elliptical: return "elliptical"
        case .rowing: return "rowing"
        case .stairClimbing: return "stairClimbing"
        case .mixedCardio: return "mixedCardio"
        case .other: return "other"
        default: return "type\(type.rawValue)"
        }
    }

    /// 來源的種類：常見的手錶 App 寫名稱，其他的只寫「其他 App」，不寫 bundle id 或裝置名稱
    fileprivate func sourceKind(_ revision: HKSourceRevision) -> String {
        let bundle = revision.source.bundleIdentifier.lowercased()
        let product = revision.productType ?? ""
        let device = product.hasPrefix("Watch") ? "Apple Watch" : product.hasPrefix("iPhone") ? "iPhone" : "其他裝置"
        let known: [(String, String)] = [
            ("com.apple.health", "Apple 內建"),
            ("com.garmin", "Garmin"),
            ("com.strava", "Strava"),
            ("com.coros", "COROS"),
            ("com.polar", "Polar"),
            ("com.suunto", "Suunto"),
            ("com.nike", "Nike Run Club"),
            ("com.huami", "Zepp／Amazfit"),
            ("com.huawei", "Huawei"),
            ("com.samsung", "Samsung"),
            ("com.fitbit", "Fitbit"),
            ("com.wahoo", "Wahoo"),
            ("com.runkeeper", "Runkeeper"),
            ("com.workoutdoors", "WorkOutDoors")
        ]
        let app = known.first { bundle.hasPrefix($0.0) }?.1 ?? "其他 App"
        return "\(app) · \(device)"
    }
}

/// 跑步的統計：每一項只留「有幾趟有」與「每分鐘幾筆」的中位數、最小、最大
private struct RunStats {
    var count = 0
    var withDistance = 0
    var withEnergy = 0
    var indoor = 0
    var withLaps = 0
    var withSegments = 0
    var withPauses = 0
    var withMultipleActivities = 0
    var withRoute = 0
    var metadataKeys: [String: Int] = [:]
    var sources: [String: Int] = [:]
    var perMinute: [String: [Double]] = [:]
    var present: [String: Int] = [:]
    var lapCounts: [Double] = []

    mutating func add(_ run: HKWorkout, probe: HealthProbePlugin) async throws {
        count += 1
        let minutes = max(run.duration / 60, 1)
        if run.totalDistance != nil { withDistance += 1 }
        if run.totalEnergyBurned != nil { withEnergy += 1 }
        if (run.metadata?[HKMetadataKeyIndoorWorkout] as? Bool) == true { indoor += 1 }
        for key in (run.metadata ?? [:]).keys { metadataKeys[key, default: 0] += 1 }
        sources[probe.sourceKind(run.sourceRevision), default: 0] += 1

        let events = run.workoutEvents ?? []
        let laps = events.filter { $0.type == .lap }.count
        if laps > 0 { withLaps += 1; lapCounts.append(Double(laps)) }
        if events.contains(where: { $0.type == .segment }) { withSegments += 1 }
        if events.contains(where: { $0.type == .pause || $0.type == .motionPaused }) { withPauses += 1 }
        if #available(iOS 16.0, *), run.workoutActivities.count > 1 { withMultipleActivities += 1 }

        var series: [(String, HKSampleType)] = [
            ("heartRate", HKQuantityType(.heartRate)),
            ("distanceWalkingRunning", HKQuantityType(.distanceWalkingRunning)),
            ("stepCount", HKQuantityType(.stepCount)),
            ("activeEnergyBurned", HKQuantityType(.activeEnergyBurned))
        ]
        if #available(iOS 16.0, *) {
            series += [
                ("runningSpeed", HKQuantityType(.runningSpeed)),
                ("runningPower", HKQuantityType(.runningPower)),
                ("runningStrideLength", HKQuantityType(.runningStrideLength)),
                ("runningVerticalOscillation", HKQuantityType(.runningVerticalOscillation)),
                ("runningGroundContactTime", HKQuantityType(.runningGroundContactTime))
            ]
        }
        for (name, type) in series {
            let found = try await probe.samples(type, from: run.startDate, to: run.endDate, limit: 20000).count
            if found > 0 {
                present[name, default: 0] += 1
                perMinute[name, default: []].append(Double(found) / minutes)
            }
        }

        let routes = try await probe.query(HKSeriesType.workoutRoute(), predicate: HKQuery.predicateForObjects(from: run), limit: 10)
            .compactMap { $0 as? HKWorkoutRoute }
        if !routes.isEmpty {
            withRoute += 1
            var points = 0
            for route in routes { points += try await probe.routePointCount(route) }
            perMinute["routePoints", default: []].append(Double(points) / minutes)
        }
    }

    func result() -> [String: Any] {
        func spread(_ values: [Double]) -> [String: Double] {
            let sorted = values.sorted()
            guard !sorted.isEmpty else { return [:] }
            let round1 = { (v: Double) in (v * 10).rounded() / 10 }
            return ["median": round1(sorted[sorted.count / 2]), "min": round1(sorted.first!), "max": round1(sorted.last!)]
        }
        return [
            "runsChecked": count,
            "withDistance": withDistance,
            "withEnergy": withEnergy,
            "indoor": indoor,
            "withLapEvents": withLaps,
            "lapsPerRun": spread(lapCounts),
            "withSegmentEvents": withSegments,
            "withPauseEvents": withPauses,
            "withMultipleActivities": withMultipleActivities,
            "withRoute": withRoute,
            "metadataKeys": metadataKeys,
            "sources": sources,
            "runsWithSeries": present,
            "samplesPerMinute": perMinute.mapValues(spread)
        ]
    }
}
