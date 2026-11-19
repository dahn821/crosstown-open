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
    public var classicBikePaceMph: Double? = nil
    public var lowAssistBikePaceMph: Double? = nil
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
    public var bikeRideType: String? = nil
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
            let name: String
            if ride.mode == .bike {
                name = ride.bikeSource == .ownBike ? "My bike" : ride.bikeRideType == "lowAssist" ? "Low-assist Citi Bike" : "Citi Bike"
            } else {
                name = ride.lineOptions?.map(\.line).joined(separator: "/") ?? ride.line ?? ride.mode.title
            }
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
    public var ebikes: Int? = nil
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
    public var trackingId: String? = nil
    public var stationId: String? = nil
    public var estimateSource: String? = nil
    public var isNextStop: Bool? = nil
    public var stop: Place
    public var metersAway: Double
    public var arrivalTime: String? = nil
    public var departureTime: String
    public var direction: String?
    public var routeColor: String?
    public var predictionReportedAt: String
}
public enum TransitArrival {
    public static func date(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }

    public static func label(arrival: String?, departure: String, now: Date) -> String {
        guard let arrives = date(arrival ?? departure), let leaves = date(departure) else { return "Unavailable" }
        if leaves < now { return "Departed" }
        let seconds = arrives.timeIntervalSince(now)
        return seconds < 60 ? "Due" : "\(Int(ceil(seconds / 60))) min"
    }
}
public struct TransitStation: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var coordinate: Coordinate
    public var metersAway: Double
}
public struct TransitDepartures: Codable, Sendable {
    public var departures: [TransitDeparture]
    public var feedStatus: LiveFeedStatus
    public var generatedAt: String
    public var radiusMeters: Int
    public var stations: [TransitStation]? = nil
}

public struct LiveVehicle: Codable, Identifiable, Sendable {
    public var id: String
    public var mode: TravelMode
    public var line: String
    public var trackingId: String? = nil
    public var coordinate: Coordinate
    public var accuracy: String
    public var status: String
    public var stopName: String?
    public var nextStop: VehicleStopPrediction? = nil
    public var motion: TrainMotion? = nil
    public var positionReport: VehiclePositionReport? = nil
    public var bearing: Double?
    public var bearingSource: String? = nil
    public var directionLabel: String? = nil
    public var reportedAt: String
    public var reportedAtSeconds: Double
    public var sourceTimestamp: String
    public var routeColor: String?
    public var source: String
    public var reportedDate: Date { Date(timeIntervalSince1970: reportedAtSeconds) }

    public init(predicted departure: TransitDeparture, reportedDate: Date) {
        id = departure.trackingId ?? departure.id
        trackingId = departure.trackingId
        mode = departure.mode
        line = departure.line
        coordinate = departure.stop.coordinate
        accuracy = "prediction-stop"
        status = "Due at \(departure.stop.name)"
        stopName = departure.stop.name
        directionLabel = departure.direction
        reportedAt = departure.predictionReportedAt
        sourceTimestamp = departure.predictionReportedAt
        reportedAtSeconds = reportedDate.timeIntervalSince1970
        routeColor = departure.routeColor
        source = "MTA subway arrival predictions"
    }

    public var accuracyLabel: String {
        switch accuracy {
        case "gps": "MTA GPS report"
        case "interpolated": "Estimated from live train reports"
        case "reported-stop": "MTA station report"
        case "prediction-stop": "MTA arrival estimate"
        default: "MTA next-stop report"
        }
    }
    public func isDue(at now: Date) -> Bool {
        guard mode == .subway, let stop = nextStop, let date = TransitArrival.date(stop.reportedAt),
              now.timeIntervalSince(date) <= 180,
              motion != nil || accuracy == "prediction-stop" || positionReport?.stopId == stop.stopId else { return false }
        return TransitArrival.label(arrival: stop.arrivalTime, departure: stop.departureTime, now: now) == "Due"
    }
}
public struct TrainMotion: Codable, Sendable {
    public var fromStopId: String
    public var toStopId: String
    public var startedAt: Double
    public var arrivesAt: Double
    public var expiresAt: Double
    public var points: [[Double]]

    public func location(at now: Date) -> (coordinate: Coordinate, bearing: Double)? {
        let milliseconds = now.timeIntervalSince1970 * 1000
        guard milliseconds <= expiresAt, arrivesAt > startedAt, points.count >= 2,
              let last = points.last, last.count == 3 else { return nil }
        let progress = min(1, max(0, (milliseconds - startedAt) / (arrivesAt - startedAt)))
        let distance = progress * last[2]
        let end = points.indices.dropFirst().first { points[$0].count == 3 && points[$0][2] >= distance } ?? points.count - 1
        let a = points[end - 1], b = points[end]
        guard a.count == 3, b.count == 3 else { return nil }
        let fraction = b[2] > a[2] ? (distance - a[2]) / (b[2] - a[2]) : 0
        let latitude = b[0] - a[0], longitude = b[1] - a[1]
        let bearing = (atan2(longitude * 84200, latitude * 111200) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        return (Coordinate(a[0] + latitude * fraction, a[1] + longitude * fraction), bearing)
    }
}
public struct VehicleStopPrediction: Codable, Sendable {
    public var stopId: String
    public var name: String
    public var coordinate: Coordinate
    public var arrivalTime: String?
    public var departureTime: String
    public var reportedAt: String

    public init(departure: TransitDeparture, stopId: String) {
        self.stopId = stopId
        name = departure.stop.name
        coordinate = departure.stop.coordinate
        arrivalTime = departure.arrivalTime
        departureTime = departure.departureTime
        reportedAt = departure.predictionReportedAt
    }
}
public struct VehiclePositionReport: Codable, Sendable {
    public var accuracy: String
    public var stopId: String?
    public var stopName: String?
    public var coordinate: Coordinate
    public var reportedAt: String
}
public struct VehicleTrip: Codable, Sendable {
    public struct Stop: Codable, Identifiable, Sendable {
        public var id: String
        public var sequence: Int
        public var name: String
        public var coordinate: Coordinate?
        public var arrivalTime: String?
        public var departureTime: String?
    }
    public enum Status: String, Codable, Sendable { case live, changed, unavailable }
    public var status: Status
    public var line: String?
    public var direction: String?
    public var routeColor: String?
    public var stops: [Stop]?
    public var segments: [[[Double]]]?
    public var reportedAt: String?
    public var position: LiveVehicle?
    public var estimateSource: String?
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
    public var network: TransitNetwork? = nil
}
public struct TransitNetwork: Codable, Sendable {
    public struct Segment: Codable, Sendable {
        public var line: String
        public var color: String?
        public var points: [[Double]]
    }
    public struct Station: Codable, Identifiable, Sendable {
        public var id: String
        public var complexId: String? = nil
        public var name: String
        public var coordinate: Coordinate
    }
    public var segments: [Segment]
    public var stations: [Station]
}
