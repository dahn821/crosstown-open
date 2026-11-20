import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum LiveRoutingError: Error, LocalizedError {
    case invalidURL, unavailable(String)
    public var errorDescription: String? {
        switch self {
        case .invalidURL: "Enter an HTTP or HTTPS address for your route server."
        case .unavailable(let message): message
        }
    }
}
public actor LiveRoutingClient {
    private struct Failure: Decodable { var error: String }
    private let baseURL: URL
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 120
        return URLSession(configuration: config)
    }()
    public init(baseURL: URL) { self.baseURL = baseURL }
    public func places(matching query: String = "") async throws -> [Place] {
        try await placeSuggestions(matching: query).places
    }
    public func placeSuggestions(matching query: String, directoryOnly: Bool = false) async throws -> PlaceSuggestions {
        var components = URLComponents(url: endpoint("places"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        if directoryOnly { components.queryItems?.append(URLQueryItem(name: "directory", value: "1")) }
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 12
        return try await fetch(request, as: PlaceSuggestions.self)
    }
    public func health(includeFeeds: Bool = true) async throws -> LiveHealth {
        var components = URLComponents(url: endpoint("health"), resolvingAgainstBaseURL: false)!
        if !includeFeeds { components.queryItems = [URLQueryItem(name: "feeds", value: "0")] }
        return try await fetch(URLRequest(url: components.url!), as: LiveHealth.self)
    }
    public func vehicles(bounds: [Double], lines: [String] = [], mode: TravelMode? = nil) async throws -> VehicleSnapshot {
        var components = URLComponents(url: endpoint("vehicles"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "bbox", value: bounds.map { String($0) }.joined(separator: ","))]
        if !lines.isEmpty { components.queryItems?.append(URLQueryItem(name: "lines", value: lines.joined(separator: ","))) }
        if let mode { components.queryItems?.append(URLQueryItem(name: "modes", value: mode.rawValue)) }
        if mode == .subway || (mode == .bus && lines.count == 1) {
            components.queryItems?.append(URLQueryItem(name: "network", value: "1"))
        }
        return try await fetch(URLRequest(url: components.url!), as: VehicleSnapshot.self)
    }
    public func vehicleTrip(id: String) async throws -> VehicleTrip {
        var components = URLComponents(url: endpoint("vehicle-trip"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "id", value: id)]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 15
        return try await fetch(request, as: VehicleTrip.self)
    }
    public func departures(near coordinate: Coordinate, mode: TravelMode? = nil, stop: String? = nil, line: String? = nil) async throws -> TransitDepartures {
        var components = URLComponents(url: endpoint("transit"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "lat", value: String(coordinate.latitude)), URLQueryItem(name: "lon", value: String(coordinate.longitude))]
        if let mode { components.queryItems?.append(URLQueryItem(name: "mode", value: mode.rawValue)) }
        if let stop { components.queryItems?.append(URLQueryItem(name: "stop", value: stop)) }
        if let line { components.queryItems?.append(URLQueryItem(name: "line", value: line)) }
        return try await fetch(URLRequest(url: components.url!), as: TransitDepartures.self)
    }
    public func plan(origin: Place, destination: Place, preferences: RoutePreferences, departureOffsetMinutes: Double = 0, departureTime: Date? = nil, arrivalTime: Date? = nil, onPreview: (@MainActor @Sendable (Itinerary) -> Void)? = nil) async throws -> PlanResponse {
        struct Request: Encodable { var origin: Place; var destination: Place; var preferences: RoutePreferences; var departureTime: String?; var arrivalTime: String? }
        let departure = departureTime?.ISO8601Format() ?? (departureOffsetMinutes == 0 ? nil : Date().addingTimeInterval(departureOffsetMinutes * 60).ISO8601Format())
        var request = URLRequest(url: endpoint("plan")); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Request(origin: origin, destination: destination, preferences: preferences, departureTime: departure, arrivalTime: arrivalTime?.ISO8601Format()))
        let response: PlanResponse
        #if canImport(Darwin)
        if let onPreview {
            request.setValue("application/x-ndjson, application/json", forHTTPHeaderField: "Accept")
            response = try await streamedPlan(request, onPreview: onPreview)
        } else {
            response = try await fetch(request, as: PlanResponse.self)
        }
        #else
        response = try await fetch(request, as: PlanResponse.self)
        #endif
        guard !response.isSample, response.routes.allSatisfy({ !$0.isSample }) else {
            throw LiveRoutingError.unavailable("The server returned sample routes. Connect to the live Crosstown server.")
        }
        return response
    }
    #if canImport(Darwin)
    private func streamedPlan(_ request: URLRequest, onPreview: @MainActor @Sendable (Itinerary) -> Void) async throws -> PlanResponse {
        struct Event: Decodable {
            let type: String
            let route: Itinerary?
            let plan: PlanResponse?
            let error: String?
        }
        guard let scheme = request.url?.scheme, ["http", "https"].contains(scheme) else { throw LiveRoutingError.invalidURL }
        do {
            let (bytes, response) = try await Self.session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw LiveRoutingError.unavailable("The route server did not respond.") }
            if http.statusCode != 200 || http.value(forHTTPHeaderField: "Content-Type")?.contains("application/x-ndjson") != true {
                var data = Data()
                for try await byte in bytes { data.append(byte) }
                return try decode(data, from: http, as: PlanResponse.self)
            }
            let decoder = JSONDecoder()
            for try await line in bytes.lines {
                let event = try decoder.decode(Event.self, from: Data(line.utf8))
                switch event.type {
                case "preview":
                    if let route = event.route, !route.isSample { await onPreview(route) }
                case "result":
                    if let plan = event.plan { return plan }
                case "error":
                    throw LiveRoutingError.unavailable(event.error ?? "The route search could not be completed.")
                default: break
                }
            }
            throw LiveRoutingError.unavailable("The route search ended early. Try again.")
        } catch { throw routingError(error) }
    }
    #endif
    private func endpoint(_ path: String) -> URL { baseURL.appendingPathComponent("api").appendingPathComponent(path) }
    private func fetch<T: Decodable & Sendable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        guard let scheme = request.url?.scheme, ["http", "https"].contains(scheme) else { throw LiveRoutingError.invalidURL }
        do {
            let (data, response) = try await Self.session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw LiveRoutingError.unavailable("The route server did not respond.") }
            return try decode(data, from: http, as: type)
        } catch { throw routingError(error) }
    }
    private func decode<T: Decodable>(_ data: Data, from response: HTTPURLResponse, as type: T.Type) throws -> T {
        guard response.statusCode == 200 else {
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            throw LiveRoutingError.unavailable(failure?.error ?? "The route server returned HTTP \(response.statusCode).")
        }
        return try JSONDecoder().decode(type, from: data)
    }
    private func routingError(_ error: Error) -> Error {
        if let error = error as? LiveRoutingError { return error }
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return CancellationError() }
        if error is DecodingError {
            return LiveRoutingError.unavailable("The route server response could not be read.")
        }
        return LiveRoutingError.unavailable("Can’t connect to the route server. Check your internet connection and the server address in Sources.")
    }
}
