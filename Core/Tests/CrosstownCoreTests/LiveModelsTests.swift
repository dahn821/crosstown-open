import XCTest
import Foundation
@testable import CrosstownCore

final class LiveModelsTests: XCTestCase {
    func testNewTripStartsFromCurrentLocationWithoutAnInventedCoordinate() {
        XCTAssertEqual(PlanRequest().origin, PlanRequest.currentLocationID)
        XCTAssertNotEqual(PlanRequest().origin, "penn")
    }
    func testSubwayCountdownRequiresTheExactLiveApproach() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let reported = now.addingTimeInterval(-15).ISO8601Format()
        let vehicle = try JSONDecoder().decode(LiveVehicle.self, from: Data("""
        {
          "id":"t","trackingId":"t","mode":"subway","line":"E","coordinate":{"latitude":40.74,"longitude":-74.0},
          "accuracy":"interpolated","status":"Estimated toward 14 St","reportedAt":"\(reported)","sourceTimestamp":"\(reported)",
          "reportedAtSeconds":1799999985,"source":"MTA",
          "positionReport":{"accuracy":"next-stop","stopId":"A31N","coordinate":{"latitude":40.74,"longitude":-74.0},"reportedAt":"\(reported)"},
          "nextStop":{"stopId":"A31N","name":"14 St","coordinate":{"latitude":40.74,"longitude":-74.0},
            "departureTime":"\(now.addingTimeInterval(55).ISO8601Format())","reportedAt":"\(reported)"},
          "motion":{"fromStopId":"A32N","toStopId":"A31N","startedAt":1799999970000,"arrivesAt":1800000030000,"expiresAt":1800000075000,
            "points":[[40.73,-74,0],[40.74,-74,1100]]}
        }
        """.utf8))
        let arrival = now.addingTimeInterval(30).ISO8601Format(), departure = now.addingTimeInterval(55).ISO8601Format()
        XCTAssertTrue(vehicle.isDue(for: "A31N", at: now))
        XCTAssertFalse(vehicle.isDue(for: "A31S", at: now))
        XCTAssertEqual(TransitArrival.subwayLabel(arrival: arrival, departure: departure, trackingId: "t", platform: "A31N",
            isNextStop: true, vehicle: vehicle, now: now), "Due")
        XCTAssertEqual(TransitArrival.subwayLabel(arrival: arrival, departure: departure, trackingId: "other", platform: "A31N",
            isNextStop: true, vehicle: vehicle, now: now), "1 min")
        XCTAssertFalse(vehicle.isDue(for: "A31N", at: now.addingTimeInterval(30)))
    }
    // Captured from the real service; test resources are never loaded by either app.
    private func capturedPlan() throws -> PlanResponse {
        let url = Bundle.module.url(forResource: "live-plan", withExtension: "json", subdirectory: "Fixtures")!
        return try JSONDecoder().decode(PlanResponse.self, from: Data(contentsOf: url))
    }
    func testRealServerContractPreservesPredictionsGeometryAndBikeCounts() throws {
        let result = try capturedPlan(), route = try XCTUnwrap(result.routes.first)
        XCTAssertFalse(result.isSample); XCTAssertFalse(route.isSample)
        let train = try XCTUnwrap(route.legs.first { $0.mode == .subway })
        XCTAssertEqual(train.realtime, true)
        XCTAssertNotNil(train.departureTime); XCTAssertNotNil(train.arrivalTime)
        XCTAssertGreaterThan(train.coordinates.count, 2)
        let bike = try XCTUnwrap(route.legs.first { $0.bikePickup != nil })
        XCTAssertGreaterThan(try XCTUnwrap(bike.bikePickup?.classicBikes), 0)
        XCTAssertGreaterThan(try XCTUnwrap(bike.bikeReturn?.docks), 0)
        XCTAssertGreaterThan(bike.bikePickup!.reportedAt, 1_000_000_000_000)
        XCTAssertNotNil(result.feedStatus?.subway.first?.sourceTimestamp)
    }
    func testSavedPreferencesPreservePersonalBikeLimitsAndLiveRequirement() throws {
        var preferences = RoutePreferences(); preferences.bikeSource = .ownBike
        preferences.maxBikingMinutes = 17; preferences.maxWalkingMinutes = 8
        preferences.priority = .sheltered; preferences.requireLiveTransit = false
        let restored = try JSONDecoder().decode(RoutePreferences.self, from: JSONEncoder().encode(preferences))
        XCTAssertEqual(restored, preferences)
    }
    func testPersonalBikeTitleDoesNotClaimARental() throws {
        var route = try XCTUnwrap(capturedPlan().routes.first)
        for index in route.legs.indices where route.legs[index].mode == .bike { route.legs[index].bikeSource = .ownBike }
        XCTAssertTrue(route.title.contains("My bike")); XCTAssertFalse(route.title.contains("Citi Bike"))
    }
    func testOlderSavedPreferencesStillDecodeAfterAddingWalkingPace() throws {
        let data = try JSONEncoder().encode(RoutePreferences())
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "walkingPace")
        let restored = try JSONDecoder().decode(RoutePreferences.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(restored.walkingPace ?? .brisk, .brisk)
    }
    func testGroupedSubwayLinesSurviveTheServerContract() throws {
        let result = try capturedPlan()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(result.routes[0])) as? [String: Any])
        var legs = try XCTUnwrap(object["legs"] as? [[String: Any]])
        let index = try XCTUnwrap(legs.firstIndex { ($0["mode"] as? String) == "subway" })
        legs[index]["lineOptions"] = [["line": "B", "routeColor": "FF6319"], ["line": "D", "routeColor": "FF6319"]]
        legs[index]["tripId"] = "reported-trip"
        object["legs"] = legs; object["groupId"] = "shared-platforms"; object["choiceId"] = "reported-trip"; object["alternativeIds"] = ["reported-trip"]
        let route = try JSONDecoder().decode(Itinerary.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(route.title.contains("B/D")); XCTAssertEqual(route.legs[index].tripId, "reported-trip")
        XCTAssertEqual(route.alternativeIds, ["reported-trip"])
    }
}
