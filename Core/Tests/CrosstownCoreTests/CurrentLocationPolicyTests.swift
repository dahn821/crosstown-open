import XCTest
import Foundation
@testable import CrosstownCore

final class CurrentLocationPolicyTests: XCTestCase {
    func testRecentAccurateLocationIsUsableWithoutWaitingForBestGPS() {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(CurrentLocationPolicy.accepts(latitude: 40.78, longitude: -73.96, accuracyMeters: 100, reportedAt: now.addingTimeInterval(-29), now: now))
    }
    func testStaleFutureAndApproximateLocationsAreNotRoutingOrigins() {
        let now = Date(timeIntervalSince1970: 1000)
        for age in [31.0, -11.0] {
            XCTAssertFalse(CurrentLocationPolicy.accepts(latitude: 40.78, longitude: -73.96, accuracyMeters: 25, reportedAt: now.addingTimeInterval(-age), now: now))
        }
        for accuracy in [-1.0, 101.0, Double.nan, Double.infinity] {
            XCTAssertFalse(CurrentLocationPolicy.accepts(latitude: 40.78, longitude: -73.96, accuracyMeters: accuracy, reportedAt: now, now: now))
        }
    }
    func testInvalidCoordinatesCannotBecomeACachedStart() {
        for coordinate in [(Double.nan, -73.96), (91.0, -73.96), (40.78, 181.0)] {
            XCTAssertFalse(CurrentLocationPolicy.accepts(latitude: coordinate.0, longitude: coordinate.1, accuracyMeters: 5, reportedAt: Date()))
        }
    }
}
