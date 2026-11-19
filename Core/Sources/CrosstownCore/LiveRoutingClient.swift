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
    private let session: URLSession
    public init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 120
        session = URLSession(configuration: config)
    }
    public func places(matching query: String = "") async throws -> [Place] {
        struct Result: Decodable { var places: [Place] }
        var components = URLComponents(url: endpoint("places"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        return try await fetch(URLRequest(url: components.url!), as: Result.self).places
    }
    public func health() async throws -> LiveHealth { try await fetch(URLRequest(url: endpoint("health")), as: LiveHealth.self) }
    public func vehicles(bounds: [Double], lines: [String] = [], mode: TravelMode? = nil) async throws -> VehicleSnapshot {
        var components = URLComponents(url: endpoint("vehicles"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "bbox", value: bounds.map { String($0) }.joined(separator: ","))]
        if !lines.isEmpty { components.queryItems?.append(URLQueryItem(name: "lines", value: lines.joined(separator: ","))) }
        if let mode { components.queryItems?.append(URLQueryItem(name: "modes", value: mode.rawValue)) }
        if mode == .subway { components.queryItems?.append(URLQueryItem(name: "network", value: "1")) }
        return try await fetch(URLRequest(url: components.url!), as: VehicleSnapshot.self)
    }
    public func departures(near coordinate: Coordinate, mode: TravelMode? = nil, stop: String? = nil, line: String? = nil) async throws -> TransitDepartures {
        var components = URLComponents(url: endpoint("transit"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "lat", value: String(coordinate.latitude)), URLQueryItem(name: "lon", value: String(coordinate.longitude))]
        if let mode { components.queryItems?.append(URLQueryItem(name: "mode", value: mode.rawValue)) }
        if let stop { components.queryItems?.append(URLQueryItem(name: "stop", value: stop)) }
        if let line { components.queryItems?.append(URLQueryItem(name: "line", value: line)) }
        return try await fetch(URLRequest(url: components.url!), as: TransitDepartures.self)
    }
    public func plan(origin: Place, destination: Place, preferences: RoutePreferences, departureOffsetMinutes: Double = 0, departureTime: Date? = nil, arrivalTime: Date? = nil) async throws -> PlanResponse {
        struct Request: Encodable { var origin: Place; var destination: Place; var preferences: RoutePreferences; var departureTime: String?; var arrivalTime: String? }
        let departure = departureTime?.ISO8601Format() ?? (departureOffsetMinutes == 0 ? nil : Date().addingTimeInterval(departureOffsetMinutes * 60).ISO8601Format())
        var request = URLRequest(url: endpoint("plan")); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Request(origin: origin, destination: destination, preferences: preferences, departureTime: departure, arrivalTime: arrivalTime?.ISO8601Format()))
        let response = try await fetch(request, as: PlanResponse.self)
        guard !response.isSample, response.routes.allSatisfy({ !$0.isSample }) else {
            throw LiveRoutingError.unavailable("The server returned sample routes. Connect to the live Crosstown server.")
        }
        return response
    }
    private func endpoint(_ path: String) -> URL { baseURL.appendingPathComponent("api").appendingPathComponent(path) }
    private func fetch<T: Decodable & Sendable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        guard let scheme = request.url?.scheme, ["http", "https"].contains(scheme) else { throw LiveRoutingError.invalidURL }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw LiveRoutingError.unavailable("The route server did not respond.") }
            guard http.statusCode == 200 else {
                let failure = try? JSONDecoder().decode(Failure.self, from: data)
                throw LiveRoutingError.unavailable(failure?.error ?? "The route server returned HTTP \(http.statusCode).")
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as LiveRoutingError { throw error }
        catch is DecodingError { throw LiveRoutingError.unavailable("The server response could not be read. Update the app and server together.") }
        catch { throw LiveRoutingError.unavailable("Can’t connect to the route server. Check your internet connection and the server address in Sources.") }
    }
}
