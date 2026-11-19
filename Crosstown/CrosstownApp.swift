import SwiftUI
import Observation
import CrosstownCore
import CoreLocation

@main @MainActor
struct CrosstownApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .tint(Theme.blue)
                .preferredColorScheme(.light)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.prepareLocation() }
                }
        }
    }
}

@MainActor @Observable
final class AppModel {
    var places: [Place] = [
        Place(id: "penn", name: "Penn Station", neighborhood: "Midtown West", coordinate: .init(40.7505, -73.9934)),
        Place(id: "ues", name: "96 St & Lexington Ave", neighborhood: "Upper East Side", coordinate: .init(40.7850, -73.9518))
    ]
    var apiBaseURLString = UserDefaults.standard.string(forKey: "crosstown.server.v2") ?? "http://127.0.0.1:4173"
    var health: LiveHealth?
    var request = PlanRequest()
    var response: PlanResponse?
    var departureSelections: [String: String] = [:]
    func resolvedRoute(_ route: Itinerary) -> Itinerary {
        guard let id = departureSelections[route.groupId ?? route.id], route.alternativeIds?.contains(id) == true,
              var option = response?.alternativeRoutes?[id] else { return route }
        option.id = route.id
        return option
    }
    func departureOptions(for route: Itinerary) -> [Itinerary] {
        (route.alternativeIds ?? []).compactMap { response?.alternativeRoutes?[$0] }
    }
    func chooseDeparture(_ option: Itinerary) {
        departureSelections[option.groupId ?? option.id] = option.choiceId ?? option.id
    }
    var error: String?
    var loading = false
    var locating = false
    var locationError: String?
    var saved: [SavedJourney] = []
    private let savedKey = "crosstown.saved.live.v2"
    private let classicPaceKey = "crosstown.bikePace.classic"
    private let lowAssistPaceKey = "crosstown.bikePace.lowAssist"
    private var latestSearch = UUID()
    private var renderedRequest: PlanRequest?
    private var renderedServer: String?
    @ObservationIgnored private let locationProvider = CurrentLocationProvider()
    private var locationToken = UUID()

    init() {
        if let data = UserDefaults.standard.data(forKey: savedKey),
           let items = try? JSONDecoder().decode([SavedJourney].self, from: data) { saved = items }
        restoreBikePaces()
        locationProvider.warmUp()
    }
    private func restoreBikePaces() {
        request.preferences.classicBikePaceMph = UserDefaults.standard.object(forKey: classicPaceKey) as? Double
        request.preferences.lowAssistBikePaceMph = UserDefaults.standard.object(forKey: lowAssistPaceKey) as? Double
    }
    func applyPreferences(_ preferences: RoutePreferences) {
        request.preferences = preferences
        UserDefaults.standard.set(preferences.classicBikePaceMph, forKey: classicPaceKey)
        UserDefaults.standard.set(preferences.lowAssistBikePaceMph, forKey: lowAssistPaceKey)
    }
    func prepareLocation() { locationProvider.warmUp() }
    var origin: Place? {
        if request.origin == PlanRequest.currentLocationID && locationError != nil { return nil }
        return places.first { $0.id == request.origin }
    }
    var originLabel: String { locating && origin == nil ? "Finding your location…" : origin?.name ?? "Current location" }
    var destination: Place? { places.first { $0.id == request.destination } }
    var tripTimeLabel: String {
        guard let date = request.arrivalTime ?? request.departureTime else { return "Leave now" }
        let formatter = DateFormatter(); formatter.timeZone = TimeZone(identifier: "America/New_York"); formatter.dateFormat = "EEE h:mm a"
        return (request.arrivalTime != nil ? "Arrive by " : "Depart at ") + formatter.string(from: date)
    }
    private func client() throws -> LiveRoutingClient {
        guard let url = URL(string: apiBaseURLString), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else { throw LiveRoutingError.invalidURL }
        return LiveRoutingClient(baseURL: url)
    }
    func refresh() async {
        if request.origin == PlanRequest.currentLocationID {
            let token = UUID(), provider = locationProvider
            locationToken = token; locating = provider.cachedPlace == nil; locationError = nil
            do {
                let place = try await withTaskCancellationHandler {
                    try await provider.locate(token: token)
                } onCancel: {
                    Task { @MainActor in provider.cancel(token: token) }
                }
                guard !Task.isCancelled, locationToken == token, request.origin == PlanRequest.currentLocationID else {
                    if locationToken == token { locating = false }
                    return
                }
                if let index = places.firstIndex(where: { $0.id == place.id }) { places[index] = place } else { places.append(place) }
                locating = false
            } catch {
                guard locationToken == token else { return }
                locating = false
                if Task.isCancelled { return }
                locationError = error.localizedDescription; response = nil; loading = false
                return
            }
        }
        await replan()
    }
    private func cancelLocation() {
        locationToken = UUID(); locationProvider.cancel(); locating = false; locationError = nil
    }
    func useCurrentLocation() {
        let alreadyCurrent = request.origin == PlanRequest.currentLocationID
        cancelLocation(); latestSearch = UUID(); response = nil; error = nil; loading = false
        request.origin = PlanRequest.currentLocationID
        if alreadyCurrent { Task { await refresh() } }
    }
    func replan() async {
        guard let origin, let destination else { return }
        loading = true
        let query = request, server = apiBaseURLString, token = UUID()
        if renderedRequest != query || renderedServer != server { response = nil; error = nil; departureSelections.removeAll() }
        latestSearch = token
        do {
            let client = try client()
            let result = try await client.plan(origin: origin, destination: destination, preferences: query.preferences, departureOffsetMinutes: query.departureMinute, departureTime: query.departureTime, arrivalTime: query.arrivalTime)
            guard !Task.isCancelled, request == query, server == apiBaseURLString, latestSearch == token else { return }
            response = result
            departureSelections = departureSelections.filter { result.alternativeRoutes?[$0.value] != nil }
            renderedRequest = query; renderedServer = server; error = nil
            health = try? await client.health()
        } catch {
            guard !Task.isCancelled, request == query, server == apiBaseURLString, latestSearch == token else { return }
            response = nil; self.error = error.localizedDescription
        }
        loading = false
    }
    func swap() {
        guard origin != nil, destination != nil else { return }
        cancelLocation(); let previous = request.origin; request.origin = request.destination; request.destination = previous
    }
    func select(_ place: Place, endpoint: Endpoint) {
        if let index = places.firstIndex(where: { $0.id == place.id }) { places[index] = place } else { places.append(place) }
        if endpoint == .origin {
            cancelLocation()
            if place.id == request.destination { swap() } else { request.origin = place.id }
        } else {
            if place.id == request.origin { swap() } else { request.destination = place.id }
        }
    }
    func searchPlaces(_ query: String) async throws -> [Place] { try await client().places(matching: query) }
    func refreshHealth() async { health = try? await client().health() }
    func configureServer(_ text: String) async {
        apiBaseURLString = text.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(apiBaseURLString, forKey: "crosstown.server.v2")
        await refresh()
    }
    var currentSavedID: String { request.origin + "|" + request.destination + "|" + request.preferences.bikeSource.rawValue }
    var isCurrentTripSaved: Bool { saved.contains { $0.id == currentSavedID } }
    func save(_ route: Itinerary) {
        guard let origin, let destination else { return }
        if let index = saved.firstIndex(where: { $0.id == currentSavedID }) { saved.remove(at: index) }
        else { saved.insert(SavedJourney(origin: origin, destination: destination, preferences: request.preferences), at: 0) }
        if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: savedKey) }
    }
    func openSaved(_ journey: SavedJourney) {
        select(journey.origin, endpoint: .origin); select(journey.destination, endpoint: .destination)
        request.preferences = journey.preferences
        restoreBikePaces()
        request.departureMinute = 0; request.departureTime = nil; request.arrivalTime = nil
        Task { await refresh() }
    }
}

@MainActor
private final class CurrentLocationProvider: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<Place, Error>?
    private var token: UUID?
    private var timeout: Task<Void, Never>?
    private var warming = false
    private var lastFix: CLLocation?
    override init() {
        super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }
    private func usable(_ location: CLLocation) -> Bool {
        CurrentLocationPolicy.accepts(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy, reportedAt: location.timestamp)
    }
    private func place(_ location: CLLocation) -> Place {
        #if targetEnvironment(simulator)
        let name = "Simulator location", neighborhood = "Simulated position for development"
        #else
        let name = "Current location", neighborhood = "Your device location"
        #endif
        return Place(id: PlanRequest.currentLocationID, name: name, neighborhood: neighborhood, coordinate: .init(location.coordinate.latitude, location.coordinate.longitude))
    }
    var cachedPlace: Place? {
        guard [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus) else { return nil }
        return [lastFix, manager.location].compactMap { $0 }.filter(usable).max(by: { $0.timestamp < $1.timestamp }).map(place)
    }
    func warmUp() {
        if let cachedPlace {
            if continuation != nil { finish(.success(cachedPlace)) }
            return
        }
        guard !warming else { return }
        warming = true
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else { requestAuthorizedLocation() }
    }
    func locate(token: UUID) async throws -> Place {
        try Task.checkCancellation()
        if let cachedPlace { return cachedPlace }
        let previous = continuation; continuation = nil; previous?.resume(throwing: CancellationError())
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation; self.token = token
            warmUp()
        }
    }
    func cancel(token: UUID? = nil) {
        if let token, token != self.token { return }
        finish(.failure(CancellationError()))
    }
    private func requestAuthorizedLocation() {
        guard warming || continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            if let cachedPlace { finish(.success(cachedPlace)); return }
            if manager.accuracyAuthorization == .reducedAccuracy { finish(.failure(LocationFailure.approximate)); return }
            guard timeout == nil else { return }
            // Start the acquisition deadline after the permission decision.
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
                self?.finish(.failure(LocationFailure.unavailable))
            }
            manager.startUpdatingLocation()
        case .denied, .restricted: finish(.failure(LocationFailure.denied))
        case .notDetermined: break
        @unknown default: finish(.failure(LocationFailure.unavailable))
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { requestAuthorizedLocation() }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last(where: usable) else { return }
        lastFix = location; finish(.success(place(location)))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .locationUnknown { return }
        finish(.failure((error as? CLError)?.code == .denied ? LocationFailure.denied : .unavailable))
    }
    private func finish(_ result: Result<Place, Error>) {
        let pending = continuation
        continuation = nil; token = nil; warming = false; timeout?.cancel(); timeout = nil; manager.stopUpdatingLocation()
        pending?.resume(with: result)
    }
    private enum LocationFailure: LocalizedError {
        case denied, unavailable, approximate
        var errorDescription: String? {
            switch self {
            case .denied: "Allow location access in Settings, or choose a starting address."
            case .unavailable:
                #if targetEnvironment(simulator)
                "Set a simulator test location, or choose a starting address."
                #else
                "Your location is unavailable. Try again or choose a starting address."
                #endif
            case .approximate: "Enable Precise Location in Settings, or choose a starting address."
            }
        }
    }
}

struct SavedJourney: Codable, Identifiable {
    var origin: Place
    var destination: Place
    var preferences: RoutePreferences
    var id: String { origin.id + "|" + destination.id + "|" + preferences.bikeSource.rawValue }
}

enum Theme {
    static let canvas = Color(hex: 0xF5F7FA)
    static let ink = Color(hex: 0x172B33)
    static let secondary = Color(hex: 0x7D8990)
    static let blue = Color(hex: 0x2D5BFF)
    static let green = Color(hex: 0x1B7960)
    static let line = Color(hex: 0xE4E6DF)
    static func mode(_ mode: TravelMode) -> Color {
        switch mode { case .walk: secondary; case .bike: blue; case .subway: green; case .bus: Color(hex: 0x9B683C) }
    }
}

extension Color {
    init(hex: UInt) { self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255) }
}
extension Double { var minuteText: String { String(Int(ceil(self))) } }
extension Itinerary {
    var fareText: String { fareCents == 0 ? "Included" : (Double(fareCents) / 100).formatted(.currency(code: "USD")) }
    var summary: String { "Crosstown: \(title), about \(minutes.minuteText) min, estimated \(fareText), \(outdoorMinutes.minuteText) min outside. \(dataSummary ?? "Travel estimate"). Refresh before travel." }
}

struct DataPill: View {
    var body: some View {
        Text("SOURCES").font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(1.1)
            .padding(.horizontal, 10).padding(.vertical, 6).background(Theme.line.opacity(0.65), in: Capsule())
            .accessibilityLabel("Live sources and server connection")
    }
}
