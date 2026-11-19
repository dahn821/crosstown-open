import SwiftUI
import MapKit
import CrosstownCore

struct JourneyMap: View {
    var route: Itinerary?
    var origin: Place?
    var destination: Place?
    var apiBaseURLString: String? = nil
    var liveMode: TravelMode? = nil
    var busStops: [Place] = []
    var selectedLine = ""
    var highlightedStations: Set<String> = []
    var onCenterChange: ((Coordinate) -> Void)? = nil
    var onStop: ((String, String, Coordinate) -> Void)? = nil
    @State private var snapshot: VehicleSnapshot?
    @State private var vehicleBounds: [Double]?
    @State private var selectedVehicle: LiveVehicle?
    @State private var vehicleError: String?
    private var region: MKCoordinateRegion {
        let a = origin?.coordinate ?? Coordinate(40.7505, -73.9934)
        if liveMode != nil {
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: a.latitude, longitude: a.longitude),
                                      span: MKCoordinateSpan(latitudeDelta: 0.024, longitudeDelta: 0.024))
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
    private var queryID: String { (apiBaseURLString ?? "") + (liveMode?.rawValue ?? "") + queryBounds.map { String($0) }.joined(separator: ",") + routeLines.joined(separator: ",") }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
        Map(initialPosition: .region(region), interactionModes: [.pan, .zoom]) {
            if let route {
                ForEach(route.legs) { leg in
                    MapPolyline(coordinates: leg.coordinates.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
                        .stroke(Theme.mode(leg.mode), style: StrokeStyle(lineWidth: leg.mode == .walk ? 3 : 5, lineCap: .round, dash: leg.mode == .walk ? [3, 6] : []))
                }
            }
            if let network = snapshot?.network, liveMode == .subway {
                ForEach(Array(network.segments.enumerated()), id: \.offset) { _, segment in
                    MapPolyline(coordinates: segmentCoordinates(segment)).stroke(.white, style: railStroke(width: 7))
                }
                ForEach(Array(network.segments.enumerated()), id: \.offset) { _, segment in
                    MapPolyline(coordinates: segmentCoordinates(segment))
                        .stroke(SubwayBadge.color(segment.line, reported: segment.color).opacity(0.92), style: railStroke(width: 4.5))
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
            ForEach(visibleVehicles(at: context.date)) { vehicle in
                Annotation(vehicle.line, coordinate: CLLocationCoordinate2D(latitude: vehicle.coordinate.latitude, longitude: vehicle.coordinate.longitude)) {
                    Button { selectedVehicle = vehicle } label: {
                        if liveMode == .subway {
                            SubwayBadge(line: vehicle.line, reportedColor: vehicle.routeColor, size: 22)
                                .shadow(color: .black.opacity(0.4), radius: 2)
                                .overlay {
                                    if let bearing = vehicle.bearing {
                                        Image(systemName: "location.north.fill").font(.system(size: 9, weight: .bold))
                                            .foregroundStyle(SubwayBadge.color(vehicle.line, reported: vehicle.routeColor))
                                            .padding(2).background(.white, in: Circle())
                                            .offset(y: -17).rotationEffect(.degrees(bearing)).accessibilityHidden(true)
                                    }
                                }
                        } else {
                            VehicleMapPin(vehicle: vehicle, compact: queryBounds[2] - queryBounds[0] > 0.045)
                        }
                    }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(vehicle.mode == .bus ? "Bus" : "Train") \(vehicle.line). \(vehicle.accuracyLabel). \(vehicle.status). \(vehicle.directionLabel ?? "")")
                }.annotationTitles(.hidden)
            }
        }.mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
            .id("\(origin?.id ?? "")-\(destination?.id ?? "")")
            .onMapCameraChange(frequency: .onEnd) { change in
                let r = change.region
                let next = [r.center.longitude - r.span.longitudeDelta / 2, r.center.latitude - r.span.latitudeDelta / 2, r.center.longitude + r.span.longitudeDelta / 2, r.center.latitude + r.span.latitudeDelta / 2].map { ($0 * 10000).rounded() / 10000 }
                if next != vehicleBounds { vehicleBounds = next }
                onCenterChange?(Coordinate((r.center.latitude * 10000).rounded() / 10000, (r.center.longitude * 10000).rounded() / 10000))
            }
            .overlay {
                if liveMode != nil {
                    Image(systemName: "scope").font(.system(size: 31, weight: .medium))
                        .foregroundStyle(Theme.blue).padding(3).background(.white, in: Circle())
                        .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .overlay(alignment: .topTrailing) { if let liveMode { liveCaption(liveMode, now: context.date) } }
            .accessibilityLabel("Map with bus GPS locations, station-based train estimates, and the selected route. Tap a vehicle for its source and report time.")
        }
        .task(id: queryID) {
            guard let apiBaseURLString, let url = URL(string: apiBaseURLString) else { return }
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            while !Task.isCancelled {
                do {
                    let result = try await LiveRoutingClient(baseURL: url).vehicles(bounds: queryBounds, lines: routeLines, mode: liveMode)
                    guard !Task.isCancelled else { return }
                    snapshot = result; vehicleError = nil
                } catch {
                    guard !Task.isCancelled else { return }
                    snapshot = nil; vehicleError = "Vehicle reports unavailable."
                }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .sheet(item: $selectedVehicle) { selected in
            let vehicle = snapshot?.vehicles.first(where: { $0.id == selected.id }) ?? selected
            VehicleReportView(vehicle: vehicle)
        }
    }
    private func visibleVehicles(at now: Date) -> [LiveVehicle] {
        (snapshot?.vehicles ?? []).filter { v in
            now.timeIntervalSince(v.reportedDate) <= 90 && (liveMode == nil || v.mode == liveMode)
        }
    }
    private func segmentCoordinates(_ segment: TransitNetwork.Segment) -> [CLLocationCoordinate2D] {
        segment.points.compactMap { pair in
            pair.count == 2 ? CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1]) : nil
        }
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
        let label = mode == .bus ? "\(count) buses with GPS" : "\(count) train station estimates"
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
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Label("\(vehicle.mode == .bus ? "Bus" : "Train") \(vehicle.line)", systemImage: vehicle.mode.symbol).font(.title.bold())
                Text(vehicle.accuracyLabel).font(.headline).foregroundStyle(Theme.green)
                Text(vehicle.status).font(.subheadline)
                if let direction = vehicle.directionLabel { Text(direction).font(.subheadline).foregroundStyle(Theme.secondary) }
                Text("Reported \(vehicle.reportedDate.formatted(date: .omitted, time: .standard)) · \(max(0, Int(Date().timeIntervalSince(vehicle.reportedDate))))s ago").font(.subheadline).foregroundStyle(Theme.secondary)
                if vehicle.accuracy != "gps" { Text("This marker uses a station location from the live MTA report. It is not an exact position between stations.").font(.subheadline).foregroundStyle(Theme.secondary) }
                Text(vehicle.source).font(.caption).foregroundStyle(Theme.secondary)
                Spacer()
            }.padding(24).navigationTitle("Vehicle report").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium]).presentationDragIndicator(.visible)
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
