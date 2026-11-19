import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct BikeStation: Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var coordinate: Coordinate
    public var bikes: Int
    public var classicBikes: Int? = nil
    public var ebikes: Int? = nil
    public var docks: Int
    public var isRenting: Bool
    public var isReturning: Bool
    public var reportedAt: Date
    public var metersAway: Double
    public var isStale: Bool { Date().timeIntervalSince(reportedAt) > 300 || reportedAt.timeIntervalSinceNow > 120 }
}

public struct BikeSnapshot: Codable, Sendable {
    public var stations: [BikeStation]
    public var updatedAt: Date
    public var fetchedAt: Date
    public var isStale: Bool { Date().timeIntervalSince(updatedAt) > 300 || updatedAt.timeIntervalSinceNow > 120 }
}

public enum BikeFeedError: Error, LocalizedError {
    case unavailable, missingFeed, invalidURL
    public var errorDescription: String? { "Citi Bike availability is unavailable. Try refreshing in a moment." }
}

private struct Flag: Decodable {
    let value: Bool
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let bool = try? value.decode(Bool.self) { self.value = bool }
        else { self.value = try value.decode(Int.self) == 1 }
    }
}

private struct FeedEnvelope<T: Decodable>: Decodable {
    var data: T
    var last_updated: Double?
}

private struct DiscoveryLanguage: Decodable {
    struct Feed: Decodable { var name: String; var url: String }
    var feeds: [Feed]
}
private struct InfoData: Decodable {
    struct Station: Decodable { var station_id: String; var name: String; var lat: Double; var lon: Double }
    var stations: [Station]
}
private struct StatusData: Decodable {
    struct Station: Decodable {
        var station_id: String
        var num_bikes_available: Int
        var num_ebikes_available: Int?
        var num_docks_available: Int
        var is_renting: Flag
        var is_returning: Flag
        var is_installed: Flag
        var last_reported: Double?
    }
    var stations: [Station]
}

public enum BikeFeedParser {
    public static func feedURLs(_ data: Data) throws -> (information: URL, status: URL) {
        let languages = try JSONDecoder().decode(FeedEnvelope<[String: DiscoveryLanguage]>.self, from: data)
        guard let feeds = (languages.data["en"] ?? languages.data.values.first)?.feeds,
              let infoText = feeds.first(where: { $0.name == "station_information" })?.url,
              let statusText = feeds.first(where: { $0.name == "station_status" })?.url,
              let info = URL(string: infoText), let status = URL(string: statusText) else { throw BikeFeedError.missingFeed }
        for url in [info, status] {
            guard url.scheme == "https", let host = url.host,
                  host == "gbfs.lyft.com" || host == "gbfs.citibikenyc.com" else { throw BikeFeedError.invalidURL }
        }
        return (info, status)
    }

    public static func snapshot(information: Data, status: Data, near origin: Coordinate? = nil, now: Date = Date()) throws -> BikeSnapshot {
        let decoder = JSONDecoder()
        let info = try decoder.decode(FeedEnvelope<InfoData>.self, from: information)
        let live = try decoder.decode(FeedEnvelope<StatusData>.self, from: status)
        // Avoid a duplicate provider ID crashing the app; retain the last report for that ID.
        let statuses = Dictionary(live.data.stations.map { ($0.station_id, $0) }, uniquingKeysWith: { _, last in last })
        let updatedAt = Date(timeIntervalSince1970: live.last_updated ?? 0)
        let stations: [BikeStation] = info.data.stations.compactMap { station in
            guard let status = statuses[station.station_id], status.is_installed.value else { return nil }
            let coordinate = Coordinate(station.lat, station.lon)
            let distance = origin.map { meters($0, coordinate) } ?? 0
            guard distance < 5000 else { return nil }
            return BikeStation(id: station.station_id, name: station.name, coordinate: coordinate,
                bikes: max(0, status.num_bikes_available),
                classicBikes: status.num_ebikes_available.map { max(0, status.num_bikes_available - $0) },
                ebikes: status.num_ebikes_available, docks: max(0, status.num_docks_available),
                isRenting: status.is_renting.value, isReturning: status.is_returning.value,
                reportedAt: Date(timeIntervalSince1970: status.last_reported ?? 0), metersAway: distance)
        }.sorted { $0.metersAway < $1.metersAway }
        return BikeSnapshot(stations: origin == nil ? stations : Array(stations.prefix(8)), updatedAt: updatedAt, fetchedAt: now)
    }

    private static func meters(_ a: Coordinate, _ b: Coordinate) -> Double {
        let radians = Double.pi / 180
        let dLat = (b.latitude - a.latitude) * radians, dLon = (b.longitude - a.longitude) * radians
        let h = pow(sin(dLat / 2), 2) + cos(a.latitude * radians) * cos(b.latitude * radians) * pow(sin(dLon / 2), 2)
        return 6_371_000 * 2 * asin(min(1, sqrt(h)))
    }
}

public actor CitiBikeClient {
    private let session: URLSession
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        self.session = URLSession(configuration: configuration)
    }
    public func nearby(_ coordinate: Coordinate) async throws -> BikeSnapshot {
        try await load(near: coordinate)
    }
    public func stations() async throws -> BikeSnapshot {
        try await load(near: nil)
    }
    private func load(near coordinate: Coordinate?) async throws -> BikeSnapshot {
        let discovery = try await fetch(URL(string: "https://gbfs.citibikenyc.com/gbfs/gbfs.json")!)
        let urls = try BikeFeedParser.feedURLs(discovery)
        async let info = fetch(urls.information)
        async let status = fetch(urls.status)
        return try await BikeFeedParser.snapshot(information: info, status: status, near: coordinate)
    }
    private func fetch(_ url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw BikeFeedError.unavailable }
        return data
    }
}
