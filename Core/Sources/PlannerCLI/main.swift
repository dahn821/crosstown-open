import Foundation
import CrosstownCore
do {
    if CommandLine.arguments.contains("--bikes") {
        let snapshot = try await CitiBikeClient().nearby(Coordinate(40.7505, -73.9934))
        print("Live Citi Bike stations: \(snapshot.stations.count)")
    } else {
        let url = URL(string: ProcessInfo.processInfo.environment["CROSSTOWN_API_URL"] ?? "http://127.0.0.1:4173")!
        let client = LiveRoutingClient(baseURL: url)
        let places = try await client.places()
        var preferences = RoutePreferences()
        if CommandLine.arguments.contains("--own-bike") { preferences.bikeSource = .ownBike }
        let response = try await client.plan(origin: places[0], destination: places[1], preferences: preferences)
        print("Live routes decoded by Swift: \(response.routes.count); candidates: \(response.consideredRoutes)")
        for route in response.routes { print("\(route.title): \(Int(ceil(route.minutes))) min, \(route.dataSummary ?? "")") }
    }
} catch { FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1) }
