import Foundation

public enum TravelMode: String, Codable, CaseIterable, Sendable {
    case walk, bike, subway, bus
    public var title: String {
        switch self { case .walk: "Walk"; case .bike: "Citi Bike"; case .subway: "Subway"; case .bus: "Bus" }
    }
    public var symbol: String {
        switch self { case .walk: "figure.walk"; case .bike: "bicycle"; case .subway: "tram.fill"; case .bus: "bus.fill" }
    }
}

public enum Priority: String, Codable, CaseIterable, Sendable {
    case fastest, cost, aboveGround, sheltered, custom
    public var title: String {
        switch self {
        case .fastest: "Fastest"; case .cost: "Spend less"; case .aboveGround: "Above ground"
        case .sheltered: "Less outside"; case .custom: "My mix"
        }
    }
    public var symbol: String {
        switch self {
        case .fastest: "bolt.fill"; case .cost: "dollarsign"; case .aboveGround: "sun.max"
        case .sheltered: "umbrella"; case .custom: "slider.horizontal.3"
        }
    }
}

public struct Coordinate: Codable, Hashable, Sendable {
    public var latitude: Double
    public var longitude: Double
    public init(_ latitude: Double, _ longitude: Double) { self.latitude = latitude; self.longitude = longitude }
}

public struct Place: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var neighborhood: String
    public var coordinate: Coordinate
    public var selectable: Bool
    public init(id: String, name: String, neighborhood: String, coordinate: Coordinate, selectable: Bool = true) {
        self.id = id; self.name = name; self.neighborhood = neighborhood
        self.coordinate = coordinate; self.selectable = selectable
    }
}

public enum BikeSource: String, Codable, CaseIterable, Sendable { case citiBike, ownBike }
public enum WalkingPace: String, Codable, CaseIterable, Sendable {
    case relaxed, standard, brisk
    public var title: String { switch self { case .relaxed: "Relaxed · 2.5 mph"; case .standard: "Standard · 3.0 mph"; case .brisk: "Brisk · 3.7 mph" } }
}

public struct RoutePreferences: Codable, Equatable, Sendable {
    public var priority: Priority = .fastest
    public var modes: [TravelMode] = [.walk, .bike, .subway, .bus]
    public var maxFareCents: Int = 1500
    public var maxWalkingMinutes: Double = 30
    public var maxBikingMinutes: Double = 45
    public var maxTransfers: Int = 2
    public var citiBikeMember: Bool = true
    public var bikeSource: BikeSource = .citiBike
    public var walkingPace: WalkingPace? = .brisk
    public var timeWeight: Double = 70
    public var costWeight: Double = 25
    public var outsideWeight: Double = 25
    public var undergroundWeight: Double = 0
    public var requireLiveTransit: Bool = true
    public init() {}
}

public struct PlanRequest: Codable, Equatable, Sendable {
    public static let currentLocationID = "current-location"
    public var origin: String
    public var destination: String
    /// Departure offset from the current time. Zero means leave now.
    public var departureMinute: Double
    public var departureTime: Date?
    public var arrivalTime: Date?
    public var preferences: RoutePreferences
    public init(origin: String = PlanRequest.currentLocationID, destination: String = "ues", departureMinute: Double = 0,
                preferences: RoutePreferences = .init(), departureTime: Date? = nil, arrivalTime: Date? = nil) {
        self.origin = origin; self.destination = destination
        self.departureMinute = departureMinute; self.preferences = preferences
        self.departureTime = departureTime; self.arrivalTime = arrivalTime
    }
}

public struct RouteLeg: Codable, Identifiable, Sendable {
    public var id: String
    public var from: Place
    public var to: Place
    public var mode: TravelMode
    public var line: String?
    public var tripId: String? = nil
    public var lineOptions: [TransitLineOption]? = nil
    public var duration: Double
    public var waitingMinutes: Double
    public var setupMinutes: Double
    public var outdoorMinutes: Double
    public var undergroundMinutes: Double
    public var instruction: String
    public var coordinates: [Coordinate]
    public var bikeSource: BikeSource? = nil
    public var realtime: Bool? = nil
    public var dataSource: String? = nil
    public var departureTime: String? = nil
    public var arrivalTime: String? = nil
    public var predictionReportedAt: String? = nil
    public var bikePickup: LiveBikeCounts? = nil
    public var bikeReturn: LiveBikeCounts? = nil
    public var steps: [StreetStep]? = nil
}

public struct TransitLineOption: Codable, Identifiable, Sendable {
    public var line: String
    public var routeColor: String?
    public var id: String { line }
}

public struct Itinerary: Codable, Identifiable, Sendable {
    public var id: String
    public var groupId: String? = nil
    public var choiceId: String? = nil
    public var alternativeIds: [String]? = nil
    public var legs: [RouteLeg]
    public var minutes: Double
    public var fareCents: Int
    public var outdoorMinutes: Double
    public var undergroundMinutes: Double
    public var walkingMinutes: Double
    public var bikingMinutes: Double
    public var transfers: Int
    public var explanation: String
    public var conventionalMinutesSaved: Int?
    public var isSample: Bool = false
    public var generatedAt: String? = nil
    public var arrivalTime: String? = nil
    public var departureTime: String? = nil
    public var dataQuality: String? = nil
    public var dataSummary: String? = nil
    public var fareAssumption: String? = nil
    public var title: String {
        let rides = legs.filter { $0.mode != .walk }
        if rides.isEmpty { return "Walk all the way" }
        var names: [String] = []
        for ride in rides {
            let name = ride.mode == .bike ? (ride.bikeSource == .ownBike ? "My bike" : "Citi Bike") : (ride.lineOptions?.map(\.line).joined(separator: "/") ?? ride.line ?? ride.mode.title)
            if names.last != name { names.append(name) }
        }
        return names.joined(separator: " + ")
    }
    public func canChooseDeparture(at now: Date = .now) -> Bool {
        let parser = ISO8601DateFormatter()
        func date(_ value: String?) -> Date? {
            guard let value else { return nil }
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let result = parser.date(from: value) { return result }
            parser.formatOptions = [.withInternetDateTime]
            return parser.date(from: value)
        }
        guard let first = legs.firstIndex(where: { $0.mode == .subway || $0.mode == .bus }),
              let departure = date(legs[first].departureTime), let start = date(departureTime) else { return false }
        let access = legs.prefix(first).reduce(0) { $0 + $1.duration } * 60
        guard departure >= max(now, start).addingTimeInterval(access + 45) else { return false }
        return legs.allSatisfy { leg in
            guard leg.realtime == true else { return true }
            guard let report = date(leg.predictionReportedAt) else { return false }
            return now.timeIntervalSince(report) <= 180
        }
    }
}

public struct PlanResponse: Codable, Sendable {
    public var routes: [Itinerary]
    public var alternativeRoutes: [String: Itinerary]? = nil
    public var routeGroups: [String: [Itinerary]]? = nil
    public var notice: String
    public var consideredRoutes: Int
    public var isSample: Bool = false
    public var generatedAt: String? = nil
    public var warnings: [String]? = nil
    public var feedStatus: LiveFeedStatus? = nil
}

public struct LiveBikeCounts: Codable, Sendable {
    public var id: String
    public var name: String
    public var bikes: Int
    public var classicBikes: Int?
    public var docks: Int
    public var isRenting: Bool
    public var isReturning: Bool
    public var reportedAt: Double
}
public struct StreetStep: Codable, Sendable {
    public var distance: Double
    public var relativeDirection: String
    public var absoluteDirection: String
    public var streetName: String
    public var walkingBike: Bool?
}
public struct LiveFeedReport: Codable, Sendable {
    public var name: String?
    public var sourceTimestamp: String?
    public var fetchedAt: String?
    public var ageSeconds: Int?
    public var stale: Bool
    public var error: String?
    public var stations: Int?
    public var configured: Bool?
}
public struct LiveFeedStatus: Codable, Sendable {
    public var subway: [LiveFeedReport]
    public var bikes: LiveFeedReport
    public var bus: LiveFeedReport
    public var busVehicles: LiveFeedReport?
}
public struct RouterStatus: Codable, Sendable {
    public var ready: Bool
    public var message: String
    public var engine: String?
    public var mode: String?
}
public struct LiveHealth: Codable, Sendable {
    public var service: String
    public var router: RouterStatus
    public var feeds: LiveFeedStatus
}

public struct TransitDeparture: Codable, Identifiable, Sendable {
    public var id: String
    public var mode: TravelMode
    public var line: String
    public var stop: Place
    public var metersAway: Double
    public var departureTime: String
    public var direction: String?
    public var routeColor: String?
    public var predictionReportedAt: String
}
public struct TransitDepartures: Codable, Sendable {
    public var departures: [TransitDeparture]
    public var feedStatus: LiveFeedStatus
    public var generatedAt: String
    public var radiusMeters: Int
}

public struct LiveVehicle: Codable, Identifiable, Sendable {
    public var id: String
    public var mode: TravelMode
    public var line: String
    public var coordinate: Coordinate
    public var accuracy: String
    public var status: String
    public var stopName: String?
    public var bearing: Double?
    public var bearingSource: String? = nil
    public var directionLabel: String? = nil
    public var reportedAt: String
    public var reportedAtSeconds: Double
    public var sourceTimestamp: String
    public var routeColor: String?
    public var source: String
    public var reportedDate: Date { Date(timeIntervalSince1970: reportedAtSeconds) }
    public var accuracyLabel: String { accuracy == "gps" ? "Reported GPS" : "Station estimate" }
}
public struct VehicleSnapshot: Codable, Sendable {
    public var vehicles: [LiveVehicle]
    public var generatedAt: String
    public var feedStatus: LiveFeedStatus
    public var refreshSeconds: Int
    public var maxVehicleAgeSeconds: Int
    public var truncated: Bool
    public var totalInView: Int
    public var notice: String
}
