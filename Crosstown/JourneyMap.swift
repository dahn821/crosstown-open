import SwiftUI
import MapKit
import CrosstownCore

struct JourneyMap: View {
    var route: Itinerary?
    var origin: Place?
    var destination: Place?
    var apiBaseURLString: String? = nil
    var liveMode: TravelMode? = nil
    var showsLiveVehicles = false
    var busStops: [Place] = []
    var selectedLine = ""
    var highlightedStations: Set<String> = []
    var stationPredictions: [TransitDeparture] = []
    var onCenterChange: ((Coordinate) -> Void)? = nil
    var onStop: ((String, String, Coordinate) -> Void)? = nil
    var onVehicleReports: (([LiveVehicle]) -> Void)? = nil
    @State private var snapshot: VehicleSnapshot?
    @State private var vehicleBounds: [Double]?
    @State private var selectedVehicle: LiveVehicle?
    @State private var trackedTrip: VehicleTrip?
    @State private var trackingError = false
    @State private var camera: MapCameraPosition?
    @State private var vehicleError: String?
    @State private var reticleFeedback = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var region: MKCoordinateRegion {
        let a = origin?.coordinate ?? Coordinate(40.7505, -73.9934)
        if liveMode != nil {
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: a.latitude, longitude: a.longitude),
                                      span: MKCoordinateSpan(latitudeDelta: 0.024, longitudeDelta: 0.024))
        }
        if let points = route?.legs.flatMap(\.coordinates), !points.isEmpty,
           let south = points.map(\.latitude).min(), let north = points.map(\.latitude).max(),
           let west = points.map(\.longitude).min(), let east = points.map(\.longitude).max() {
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (north + south) / 2, longitude: (east + west) / 2),
                span: MKCoordinateSpan(latitudeDelta: max(0.004, (north - south) * 1.35), longitudeDelta: max(0.004, (east - west) * 1.35)))
        }
        let b = destination?.coordinate ?? Coordinate(40.785, -73.9518)
        return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (a.latitude + b.latitude) / 2 + 0.008,
            longitude: (a.longitude + b.longitude) / 2), span: MKCoordinateSpan(latitudeDelta: max(0.025, abs(a.latitude - b.latitude) * 1.8), longitudeDelta: max(0.025, abs(a.longitude - b.longitude) * 1.65)))
    }
    private var queryBounds: [Double] {
        if let vehicleBounds { return vehicleBounds }
        let r = region
        return [r.center.longitude - r.span.longitudeDelta / 2, r.center.latitude - r.span.latitudeDelta / 2, r.center.longitude + r.span.longitudeDelta / 2, r.center.latitude + r.span.latitudeDelta / 2]
    }
    private var routeLines: [String] { selectedLine.isEmpty ? [] : [selectedLine] }
    private var vehiclesEnabled: Bool { liveMode != nil || showsLiveVehicles }
    private var queryID: String { (vehiclesEnabled ? apiBaseURLString ?? "" : "") + (liveMode?.rawValue ?? "") + queryBounds.map { String($0) }.joined(separator: ",") + routeLines.joined(separator: ",") }
    var body: some View {
        TimelineView(.periodic(from: .now, by: vehiclesEnabled && liveMode != .bus && !reduceMotion ? 0.25 : 1)) { context in
        Map(position: Binding(get: { camera ?? .region(region) }, set: { camera = $0 }), interactionModes: [.pan, .zoom]) {
            if let route {
                ForEach(route.legs) { leg in
                    let coordinates = leg.coordinates.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
                    let color = leg.mode == .subway ? SubwayBadge.color(leg.line ?? "", reported: leg.routeColor) : Theme.mode(leg.mode)
                    MapPolyline(coordinates: coordinates).stroke(.white, style: railStroke(width: leg.mode == .walk ? 6 : 9))
                    MapPolyline(coordinates: coordinates)
                        .stroke(color, style: StrokeStyle(lineWidth: leg.mode == .walk ? 3 : 6, lineCap: .round,
                            lineJoin: .round, dash: leg.mode == .walk ? [2, 7] : []))
                }
            }
            if let network = snapshot?.network, liveMode == .subway {
                ForEach(Array(network.segments.enumerated()), id: \.offset) { _, segment in
                    MapPolyline(coordinates: segmentCoordinates(segment)).stroke(.white, style: railStroke(width: 7))
                }
                ForEach(Array(network.segments.enumerated()), id: \.offset) { _, segment in
                    MapPolyline(coordinates: segmentCoordinates(segment))
                        .stroke(SubwayBadge.color(segment.line, reported: segment.color).opacity(selectedVehicle == nil ? 0.92 : 0.22), style: railStroke(width: 4.5))
                }
                if queryBounds[2] - queryBounds[0] < 0.11 {
                    ForEach(network.stations) { station in
                        Annotation(station.name, coordinate: CLLocationCoordinate2D(latitude: station.coordinate.latitude, longitude: station.coordinate.longitude)) {
                            stopButton(station.complexId ?? station.id, station.name, station.coordinate)
                        }
                    }.annotationTitles(.hidden)
                }
            }
            if liveMode == .bus {
                ForEach(busStops) { stop in
                    Annotation(stop.name, coordinate: CLLocationCoordinate2D(latitude: stop.coordinate.latitude, longitude: stop.coordinate.longitude)) {
                        stopButton(stop.id, stop.name, stop.coordinate)
                    }
                }.annotationTitles(.hidden)
            }
            if let origin {
                Annotation("Start", coordinate: CLLocationCoordinate2D(latitude: origin.coordinate.latitude, longitude: origin.coordinate.longitude)) {
                    Circle().fill(Theme.blue).frame(width: 13, height: 13).padding(4).background(.white, in: Circle()).shadow(radius: 3)
                }
            }
            if let destination {
                Annotation("Destination", coordinate: CLLocationCoordinate2D(latitude: destination.coordinate.latitude, longitude: destination.coordinate.longitude)) {
                    Image(systemName: "flag.fill").font(.system(size: 14)).foregroundStyle(.white).padding(10).background(Theme.ink, in: Circle())
                }
            }
            if let trip = trackedTrip, let selectedVehicle {
                trackingPaths(trip, vehicle: selectedVehicle)
            }
            ForEach(vehicleGroups(at: context.date)) { group in
                let coordinate = group.vehicles[0].coordinate
                Annotation("Vehicle", coordinate: CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude)) {
                    vehicleButton(group.vehicles, at: context.date)
                }.annotationTitles(.hidden)
            }
        }.mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
            .id("\(origin?.id ?? "")-\(destination?.id ?? "")")
            .onMapCameraChange(frequency: .onEnd) { change in
                let r = change.region
                let next = [r.center.longitude - r.span.longitudeDelta / 2, r.center.latitude - r.span.latitudeDelta / 2, r.center.longitude + r.span.longitudeDelta / 2, r.center.latitude + r.span.latitudeDelta / 2].map { ($0 * 10000).rounded() / 10000 }
                if liveMode != nil, selectedVehicle == nil, camera?.positionedByUser == true, let old = vehicleBounds {
                    let north = r.center.latitude - (old[1] + old[3]) / 2
                    let east = r.center.longitude - (old[0] + old[2]) / 2
                    if hypot(north * 111200, east * 84200) > 20 { reticleFeedback += 1 }
                }
                if next != vehicleBounds { vehicleBounds = next }
                if selectedVehicle == nil {
                    onCenterChange?(Coordinate((r.center.latitude * 10000).rounded() / 10000, (r.center.longitude * 10000).rounded() / 10000))
                }
            }
            .overlay {
                if liveMode != nil && selectedVehicle == nil {
                    Image(systemName: "scope").font(.system(size: 31, weight: .medium))
                        .foregroundStyle(Theme.blue).padding(3).background(.white, in: Circle())
                        .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .overlay(alignment: .topTrailing) { if let liveMode { liveCaption(liveMode, now: context.date) } }
            .accessibilityLabel(vehiclesEnabled ? "Live transit map. Tap a vehicle to see its upcoming stops." : "Journey map")
        }
        .sensoryFeedback(.selection, trigger: reticleFeedback)
        .onChange(of: origin?.id) { _, _ in camera = nil }
        .onChange(of: destination?.id) { _, _ in camera = nil }
        .onChange(of: route?.choiceId ?? route?.id) { _, _ in camera = nil }
        .task(id: queryID) {
            guard vehiclesEnabled, let apiBaseURLString, let url = URL(string: apiBaseURLString) else {
                snapshot = nil
                return
            }
            let client = LiveRoutingClient(baseURL: url)
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            while !Task.isCancelled {
                do {
                    let result = try await client.vehicles(bounds: queryBounds, lines: routeLines, mode: liveMode)
                    guard !Task.isCancelled else { return }
                    snapshot = result; vehicleError = nil
                    onVehicleReports?(result.vehicles)
                } catch {
                    guard !Task.isCancelled else { return }
                    snapshot = nil; vehicleError = "Vehicle reports unavailable."
                    onVehicleReports?([])
                }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .task(id: selectedVehicle?.id) {
            trackedTrip = nil; trackingError = false
            guard let vehicle = selectedVehicle, let id = vehicle.trackingId,
                  let apiBaseURLString, let url = URL(string: apiBaseURLString) else { return }
            let client = LiveRoutingClient(baseURL: url)
            var fitted = false
            while !Task.isCancelled {
                do {
                    let trip = try await client.vehicleTrip(id: id)
                    guard !Task.isCancelled else { return }
                    trackedTrip = trip; trackingError = false
                    if !fitted && trip.status == .live { fitted = fitTrip(trip) }
                } catch {
                    guard !Task.isCancelled else { return }
                    trackedTrip = nil; trackingError = true
                }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .sheet(item: $selectedVehicle, onDismiss: {
            trackedTrip = nil
            if let center = vehicleBounds {
                onCenterChange?(Coordinate((center[1] + center[3]) / 2, (center[0] + center[2]) / 2))
            }
        }) { selected in
            let current = visibleVehicles(at: .now).first { $0.id == selected.id || ($0.trackingId != nil && $0.trackingId == selected.trackingId) }
            VehicleReportView(vehicle: current ?? selected, current: current != nil, trip: trackedTrip, error: trackingError)
        }
    }
    private struct VehicleGroup: Identifiable {
        var id: String
        var vehicles: [LiveVehicle]
    }
    private func showsDue(_ vehicle: LiveVehicle, at now: Date) -> Bool {
        guard selectedVehicle == nil, liveMode == .subway, let id = vehicle.trackingId,
              let platform = vehicle.nextStop?.stopId, vehicle.isDue(for: platform, at: now) else { return false }
        return stationPredictions.contains { $0.trackingId == id && $0.platformID == platform && $0.isNextStop != false }
    }
    private func vehicleGroups(at now: Date) -> [VehicleGroup] {
        Dictionary(grouping: visibleVehicles(at: now)) { vehicle in
            guard vehicle.mode == .subway else { return vehicle.id }
            if let motion = vehicle.motion, now.timeIntervalSince1970 * 1000 < motion.arrivesAt { return vehicle.id }
            let latitude = (vehicle.coordinate.latitude * 100000).rounded()
            let longitude = (vehicle.coordinate.longitude * 100000).rounded()
            return "\(latitude),\(longitude)"
        }.map { VehicleGroup(id: $0.key, vehicles: $0.value.sorted {
            if showsDue($0, at: now) != showsDue($1, at: now) { return showsDue($0, at: now) }
            return $0.id < $1.id
        }) }.sorted { $0.id < $1.id }
    }
    @ViewBuilder private func vehicleButton(_ vehicles: [LiveVehicle], at now: Date) -> some View {
        let vehicle = vehicles[0], due = vehicles.filter { showsDue($0, at: now) }.count
        if vehicles.count > 1 {
            Menu {
                ForEach(vehicles) { item in
                    Button(vehicleLabel(item, at: now)) { selectedVehicle = item }
                }
            } label: {
                vehiclePin(vehicle, due: due).opacity(markerOpacity(vehicles))
            }.buttonStyle(.plain).accessibilityLabel("\(vehicles.count) trains at this marker, \(due) due")
        } else {
            Button { selectedVehicle = vehicle } label: { vehiclePin(vehicle, due: due).opacity(markerOpacity(vehicles)) }
                .buttonStyle(.plain).accessibilityLabel(vehicleLabel(vehicle, at: now))
        }
    }
    private func markerOpacity(_ vehicles: [LiveVehicle]) -> Double {
        guard let selectedVehicle else { return 1 }
        return vehicles.contains { $0.id == selectedVehicle.id || ($0.trackingId != nil && $0.trackingId == selectedVehicle.trackingId) } ? 1 : 0.25
    }
    private func vehicleLabel(_ vehicle: LiveVehicle, at now: Date) -> String {
        [vehicle.mode == .bus ? "Bus \(vehicle.line)" : "Train \(vehicle.line)", vehicle.directionLabel,
         showsDue(vehicle, at: now) ? "Due" : nil, vehicle.accuracyLabel, vehicle.status].compactMap { $0 }.joined(separator: ", ")
    }
    @ViewBuilder private func vehiclePin(_ vehicle: LiveVehicle, due: Int) -> some View {
        if vehicle.mode == .subway && liveMode == .subway {
            SubwayBadge(line: vehicle.line, reportedColor: vehicle.routeColor, size: 22)
                .background {
                    if vehicle.accuracy == "prediction-stop" || vehicle.accuracy == "interpolated" {
                        Circle().strokeBorder(Theme.green, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])).padding(-3)
                    }
                }
                .shadow(color: .black.opacity(0.4), radius: 2)
                .overlay {
                    if let bearing = vehicle.bearing {
                        Image(systemName: "location.north.fill").font(.system(size: 9, weight: .bold))
                            .foregroundStyle(SubwayBadge.color(vehicle.line, reported: vehicle.routeColor))
                            .padding(2).background(.white, in: Circle())
                            .offset(y: -17).rotationEffect(.degrees(bearing)).accessibilityHidden(true)
                    }
                }
                .overlay(alignment: .bottom) {
                    if due > 0 {
                        Text(due > 1 ? "Due ×\(due)" : "Due").font(.system(size: 9, weight: .bold)).fixedSize()
                            .foregroundStyle(.white).padding(.horizontal, 4).padding(.vertical, 2)
                            .background(Theme.green, in: Capsule()).offset(y: 14).accessibilityHidden(true)
                    }
                }
                .frame(minWidth: 30, minHeight: 33).contentShape(Rectangle())
        } else {
            VehicleMapPin(vehicle: vehicle, compact: queryBounds[2] - queryBounds[0] > 0.045)
        }
    }
    private func visibleVehicles(at now: Date) -> [LiveVehicle] {
        guard vehiclesEnabled else { return [] }
        var reports: [String: LiveVehicle] = [:]
        let positions = (snapshot?.vehicles ?? []) + [trackedTrip?.position].compactMap { $0 }
        for var vehicle in positions where liveMode == nil || vehicle.mode == liveMode {
            if vehicle.accuracy == "prediction-stop" {
                guard let position = vehicle.positionReport, let seen = TransitArrival.date(position.reportedAt) else { continue }
                vehicle.accuracy = position.accuracy; vehicle.coordinate = position.coordinate
                vehicle.stopName = position.stopName; vehicle.reportedAt = position.reportedAt
                vehicle.reportedAtSeconds = seen.timeIntervalSince1970
                vehicle.status = position.stopName.map { position.accuracy == "reported-stop" ? "Reported at \($0)" : "Heading toward \($0)" } ?? "MTA station report"
                vehicle.bearing = nil; vehicle.directionLabel = nil; vehicle.nextStop = nil
            }
            if now.timeIntervalSince(vehicle.reportedDate) <= (vehicle.accuracy == "prediction-stop" ? 180 : 90) {
                let id = vehicle.trackingId ?? vehicle.id
                if reports[id]?.reportedDate ?? .distantPast <= vehicle.reportedDate { reports[id] = vehicle }
            }
        }
        return reports.values.map { vehicle in
            var vehicle = vehicle
            if let sample = vehicle.motion?.location(at: now) {
                vehicle.coordinate = sample.coordinate
                vehicle.bearing = sample.bearing
            }
            return vehicle
        }
    }
    private func segmentCoordinates(_ segment: TransitNetwork.Segment) -> [CLLocationCoordinate2D] {
        pathCoordinates(segment.points)
    }
    private func pathCoordinates(_ points: [[Double]]) -> [CLLocationCoordinate2D] {
        points.compactMap { pair in
            pair.count == 2 ? CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1]) : nil
        }
    }
    @MapContentBuilder private func trackingPaths(_ trip: VehicleTrip, vehicle: LiveVehicle) -> some MapContent {
        let paths = trip.segments ?? []
        let color = vehicle.mode == .bus ? Theme.blue : SubwayBadge.color(vehicle.line, reported: trip.routeColor)
        ForEach(paths.indices, id: \.self) { i in
            MapPolyline(coordinates: pathCoordinates(paths[i])).stroke(.white, style: railStroke(width: 9))
        }
        ForEach(paths.indices, id: \.self) { i in
            MapPolyline(coordinates: pathCoordinates(paths[i])).stroke(color, style: railStroke(width: 6))
        }
        ForEach(trip.stops ?? [], id: \.sequence) { stop in
            if let at = stop.coordinate {
                Annotation(stop.name, coordinate: CLLocationCoordinate2D(latitude: at.latitude, longitude: at.longitude)) {
                    Circle().fill(.white).overlay { Circle().strokeBorder(color, lineWidth: 2) }.frame(width: 9, height: 9)
                }.annotationTitles(.hidden)
            }
        }
    }
    private func fitTrip(_ trip: VehicleTrip) -> Bool {
        let coordinates = (trip.stops ?? []).compactMap(\.coordinate) + [trip.position?.coordinate].compactMap { $0 }
        let points = (trip.segments ?? []).flatMap(pathCoordinates) + coordinates.map {
            CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
        }
        guard let south = points.map(\.latitude).min(), let north = points.map(\.latitude).max(),
              let west = points.map(\.longitude).min(), let east = points.map(\.longitude).max() else { return false }
        camera = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (north + south) / 2, longitude: (west + east) / 2),
            span: MKCoordinateSpan(latitudeDelta: max(0.008, (north - south) * 1.8), longitudeDelta: max(0.008, (east - west) * 1.45))))
        return true
    }
    private func railStroke(width: CGFloat) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
    }
    private func stopButton(_ id: String, _ name: String, _ coordinate: Coordinate) -> some View {
        Button { onStop?(id, name, coordinate) } label: {
            Circle().fill(.white)
                .overlay { Circle().strokeBorder(highlightedStations.contains(id) ? Theme.blue : Theme.mode(liveMode ?? .subway), lineWidth: 2) }
                .frame(width: 12, height: 12).padding(5)
        }.buttonStyle(.plain).accessibilityLabel("Show arrivals at \(name)")
    }
    private func liveCaption(_ mode: TravelMode, now: Date) -> some View {
        let count = visibleVehicles(at: now).count
        let label = mode == .bus ? "\(count) buses with GPS" : "Estimated from live train reports"
        let note = vehicleError ?? (mode == .bus && snapshot?.feedStatus.busVehicles?.stale == true ? "Bus GPS unavailable" : label)
        return Text(note).font(.caption2.weight(.semibold)).foregroundStyle(Theme.ink)
            .padding(9).background(.regularMaterial, in: Capsule()).padding(9)
    }
}

struct SubwayBadge: View {
    let line: String
    let reportedColor: String?
    var size: CGFloat = 22

    private static let shuttles = ["FS": "Franklin Avenue Shuttle", "GS": "42 Street Shuttle", "H": "Rockaway Park Shuttle"]
    private static let palette: [(String, UInt)] = [
        ("123", 0xEE352E), ("456", 0x00933C), ("7", 0xB933AD), ("ACE", 0x0039A6), ("BDFM", 0xFF6319),
        ("G", 0x6CBE45), ("JZ", 0x996633), ("L", 0xA7A9AC), ("NQRW", 0xFCCC0A), ("S", 0x808183)
    ]
    private static func express(_ line: String) -> Bool { ["6X", "7X", "FX"].contains(line) }
    static func name(_ line: String) -> String { shuttles[line] ?? (express(line) ? "\(line.dropLast()) express" : line) }
    private static func label(_ line: String) -> String { shuttles[line] != nil ? "S" : express(line) ? String(line.dropLast()) : line }
    private static func rgb(_ line: String, reported: String?) -> UInt {
        if let hex = reported, hex.count == 6, let value = UInt(hex, radix: 16) { return value }
        let service = label(line)
        return service.count == 1 ? palette.first(where: { $0.0.contains(service) })?.1 ?? 0x4A6371 : 0x4A6371
    }
    static func color(_ line: String, reported: String?) -> Color { Color(hex: rgb(line, reported: reported)) }

    var body: some View {
        let paint = Self.rgb(line, reported: reportedColor)
        let channels = [16, 8, 0].map { shift in
            let v = Double((paint >> shift) & 255) / 255
            return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        let luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
        Text(Self.label(line)).font(.system(size: size * 0.62, weight: .heavy)).lineLimit(1).minimumScaleFactor(0.72)
            .foregroundStyle(luminance > 0.18 ? .black : .white).frame(width: size, height: size)
            .background {
                if Self.express(line) {
                    RoundedRectangle(cornerRadius: 2).fill(Color(hex: paint))
                        .frame(width: size * 0.72, height: size * 0.72).rotationEffect(.degrees(45))
                } else { Circle().fill(Color(hex: paint)) }
            }.accessibilityLabel(Self.name(line))
    }
}

private struct VehicleMapPin: View {
    let vehicle: LiveVehicle
    let compact: Bool
    private var color: Color { vehicle.routeColor.flatMap { UInt($0, radix: 16) }.map { Color(hex: $0) } ?? (vehicle.mode == .bus ? Theme.blue : Theme.green) }
    var body: some View {
        HStack(spacing: 4) {
            if !compact || vehicle.mode == .bus { Image(systemName: vehicle.mode.symbol).font(.system(size: 10, weight: .bold)) }
            if !compact || vehicle.mode == .subway { Text(vehicle.line).font(.system(size: 10, weight: .bold)) }
            if !compact, let bearing = vehicle.bearing { Image(systemName: "location.north.fill").font(.system(size: 9)).rotationEffect(.degrees(bearing)) }
        }.padding(.horizontal, compact ? 5 : 7).padding(.vertical, 6)
            .foregroundStyle(vehicle.accuracy == "gps" ? .white : Theme.ink)
            .background(vehicle.accuracy == "gps" ? color : .white, in: Capsule())
            .overlay { Capsule().stroke(color, style: StrokeStyle(lineWidth: 2, dash: vehicle.accuracy == "gps" ? [] : [3, 2])) }
            .overlay {
                if compact, let bearing = vehicle.bearing {
                    Image(systemName: "location.north.fill").font(.system(size: 11, weight: .black))
                        .foregroundStyle(color).padding(2).background(.white, in: Circle())
                        .offset(y: -17).rotationEffect(.degrees(bearing))
                        .accessibilityHidden(true)
                }
            }
            .shadow(color: .black.opacity(0.2), radius: 3, y: 1)
    }
}
private struct VehicleReportView: View {
    let vehicle: LiveVehicle
    let current: Bool
    let trip: VehicleTrip?
    let error: Bool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(current ? vehicle.accuracyLabel + " · " + vehicle.status : vehicle.mode == .subway ? "Estimated from live train reports" : "MTA live arrival predictions")
                        .font(.subheadline).foregroundStyle(Theme.secondary)
                    if let direction = trip?.direction ?? vehicle.directionLabel {
                        Text(direction).font(.caption).foregroundStyle(Theme.secondary)
                    }
                    if let trip, trip.status == .live {
                        stopList(trip.stops ?? [])
                        if trip.segments?.isEmpty != false { Text("Route path unavailable.").font(.caption).foregroundStyle(Theme.secondary) }
                    } else if trip?.status == .changed {
                        Text("MTA reported a change to this trip.").font(.subheadline)
                    } else if trip?.status == .unavailable || vehicle.trackingId == nil || error {
                        Text("Upcoming live stops are unavailable.").font(.subheadline)
                    } else {
                        ProgressView("Checking upcoming stops…")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 7)
            }
                .navigationTitle("\(vehicle.mode == .bus ? "Bus" : "Train") \(vehicle.line)").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.height(255), .large]).presentationDragIndicator(.visible)
            .presentationBackgroundInteraction(.enabled(upThrough: .height(255)))
    }
    private func stopList(_ stops: [VehicleTrip.Stop]) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            LazyVStack(alignment: .leading, spacing: 0) {
                Text("Upcoming stops").font(.caption.weight(.semibold)).accessibilityAddTraits(.isHeader).padding(.bottom, 5)
                ForEach(stops, id: \.sequence) { stop in
                    HStack(spacing: 10) {
                        Circle().fill(Theme.mode(vehicle.mode)).frame(width: 7, height: 7).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(stop.name).font(.subheadline.weight(.semibold))
                            if stop.sequence == stops.first?.sequence {
                                Text("Next stop").font(.caption2).foregroundStyle(Theme.secondary)
                            }
                        }
                        Spacer(minLength: 4)
                        Text(countdown(stop, first: stop.sequence == stops.first?.sequence, at: context.date))
                            .font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.green)
                    }.frame(minHeight: 43)
                    Divider()
                }
            }
        }
    }
    private func countdown(_ stop: VehicleTrip.Stop, first: Bool, at now: Date) -> String {
        guard let departure = stop.departureTime else { return "Awaiting report" }
        if vehicle.mode == .subway {
            return TransitArrival.subwayLabel(arrival: stop.arrivalTime, departure: departure, trackingId: vehicle.trackingId,
                platform: stop.id, isNextStop: first, vehicle: vehicle, now: now)
        }
        return TransitArrival.label(arrival: stop.arrivalTime, departure: departure, now: now)
    }
}

struct RouteCard: View {
    let route: Itinerary
    let recommended: Bool
    let priority: Priority
    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    if recommended {
                        Label(priority == .fastest ? "A GOOD CONNECTION" : "YOUR \(priority.title.uppercased()) PICK", systemImage: "sparkle")
                            .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1)
                    }
                    Text(route.title).font(.system(size: 19, weight: .semibold)).tracking(-0.5)
                    Text(route.dataQuality == "scheduled" ? "Includes scheduled transit" : (route.dataSummary ?? "Street time estimate"))
                        .font(.system(size: 10)).opacity(0.8)
                }
                Spacer(minLength: 8)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(route.minutes.minuteText).font(.system(size: 34, weight: .semibold)).tracking(-1.8)
                    Text("min").font(.system(size: 12))
                }
            }
            HStack(spacing: 8) {
                ForEach(route.legs) { leg in
                    HStack(spacing: 4) {
                        if let options = leg.lineOptions, !options.isEmpty {
                            HStack(spacing: 3) {
                                ForEach(options) { option in
                                    Text(option.line).font(.system(size: 10, weight: .bold)).frame(minWidth: 21, minHeight: 21)
                                        .foregroundStyle(["FCCC0A", "F9B514"].contains(option.routeColor?.uppercased() ?? "") ? Color.black : Color.white)
                                        .background(option.routeColor.flatMap { UInt($0, radix: 16) }.map { Color(hex: $0) } ?? Theme.green, in: Circle())
                                }
                            }
                        }
                        else if let line = leg.line { Text(line).font(.system(size: 11, weight: .bold)).padding(5).background(recommended ? .white.opacity(0.2) : Theme.mode(leg.mode).opacity(0.1), in: Capsule()) }
                        else { Image(systemName: leg.mode.symbol).font(.system(size: 14)) }
                        Text(leg.duration.minuteText).font(.system(size: 11, weight: .medium))
                    }
                    if leg.id != route.legs.last?.id { Image(systemName: "chevron.right").font(.system(size: 6, weight: .bold)).opacity(0.5) }
                }
            }.lineLimit(1).minimumScaleFactor(0.65).accessibilityElement(children: .ignore)
                .accessibilityLabel(route.legs.map { "\($0.mode.title) \($0.duration.minuteText) minutes" }.joined(separator: ", "))
            HStack(spacing: 12) {
                Text(route.fareText + " est.")
                Text("·").opacity(0.4)
                Label("\(route.outdoorMinutes.minuteText) min outside", systemImage: "cloud.sun")
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").fontWeight(.semibold)
            }.font(.system(size: 12))
            if recommended {
                Rectangle().fill(.white.opacity(0.2)).frame(height: 1)
                Text(route.explanation).font(.system(size: 12)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(20).foregroundStyle(recommended ? .white : Theme.ink)
            .background(recommended ? Theme.blue : .white, in: .rect(cornerRadius: 23))
    }
}
