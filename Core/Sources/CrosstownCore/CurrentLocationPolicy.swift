import Foundation

public enum CurrentLocationPolicy {
    public static let maximumAge: TimeInterval = 30
    public static let maximumAccuracyMeters: Double = 100

    public static func accepts(latitude: Double, longitude: Double, accuracyMeters: Double, reportedAt: Date, now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(reportedAt)
        return latitude.isFinite && longitude.isFinite && abs(latitude) <= 90 && abs(longitude) <= 180
            && accuracyMeters.isFinite && accuracyMeters >= 0 && accuracyMeters <= maximumAccuracyMeters
            && age.isFinite && age >= -10 && age <= maximumAge
    }
}
