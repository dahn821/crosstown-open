import SwiftUI
import MapKit
import CrosstownCore

struct JourneyMap: View {
    var route: Itinerary?
    var origin: Place?
    var destination: Place?
    var apiBaseURLString: String? = nil
    var showsVehicleControls = false
    @State private var snapshot: VehicleSnapshot?
    @State private var vehicleBounds: [Double]?
    @State private var selectedVehicle: LiveVehicle?
    @State private var busesVisible = true
    @State private var trainsVisible = true
    @State private var routeLinesOnly = false
    @State private var controlsExpanded = false
    @State private var vehicleError: String?
    private var region: MKCoordinateRegion {
        let a = origin?.coordinate ?? Coordinate(40.7505, -73.9934)
        let b = destination?.coordinate ?? Coordinate(40.785, -73.9518)
        return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (a.latitude + b.latitude) / 2 + 0.008,
            longitude: (a.longitude + b.longitude) / 2), span: MKCoordinateSpan(latitudeDelta: max(0.025, abs(a.latitude - b.latitude) * 1.8), longitudeDelta: max(0.025, abs(a.longitude - b.longitude) * 1.65)))
    }
    private var queryBounds: [Double] {
        if let vehicleBounds { return vehicleBounds }
        let r = region
        return [r.center.longitude - r.span.longitudeDelta / 2, r.center.latitude - r.span.latitudeDelta / 2, r.center.longitude + r.span.longitudeDelta / 2, r.center.latitude + r.span.latitudeDelta / 2]
    }
    private var routeLines: [String] { routeLinesOnly ? Array(Set(route?.legs.compactMap(\.line) ?? [])).sorted() : [] }
    private var queryID: String { (apiBaseURLString ?? "") + queryBounds.map { String($0) }.joined(separator: ",") + routeLines.joined(separator: ",") }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
        Map(initialPosition: .region(region), interactionModes: [.pan, .zoom]) {
            if let route {
                ForEach(route.legs) { leg in
                    MapPolyline(coordinates: leg.coordinates.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
                        .stroke(Theme.mode(leg.mode), style: StrokeStyle(lineWidth: leg.mode == .walk ? 3 : 5, lineCap: .round, dash: leg.mode == .walk ? [3, 6] : []))
                }
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
                    Button { selectedVehicle = vehicle } label: { VehicleMapPin(vehicle: vehicle, compact: queryBounds[2] - queryBounds[0] > 0.045) }
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
            }
            .overlay(alignment: .topTrailing) { if showsVehicleControls { vehicleControls(now: context.date) } }
            .accessibilityLabel("Map with bus GPS locations, station-based train estimates, and the selected route. Tap a vehicle for its source and report time.")
        }
        .task(id: queryID) {
            guard let apiBaseURLString, let url = URL(string: apiBaseURLString) else { return }
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            while !Task.isCancelled {
                do {
                    let result = try await LiveRoutingClient(baseURL: url).vehicles(bounds: queryBounds, lines: routeLines)
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
            now.timeIntervalSince(v.reportedDate) <= 90 && (v.mode == .bus ? busesVisible : trainsVisible)
        }
    }
    private func vehicleControls(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Button { controlsExpanded.toggle() } label: { Label("Layers", systemImage: "slider.horizontal.3").font(.caption.weight(.semibold)) }
                    .accessibilityLabel("Vehicle map layers")
                Spacer()
                Text("\(visibleVehicles(at: now).count) vehicles").font(.caption2).foregroundStyle(Theme.secondary)
            }
            if controlsExpanded {
            Toggle("Bus GPS", isOn: $busesVisible)
            Toggle("Train station estimates", isOn: $trainsVisible)
            if !(route?.legs.compactMap(\.line).isEmpty ?? true) { Toggle("Selected route lines", isOn: $routeLinesOnly) }
            Text("\(visibleVehicles(at: now).count) vehicles · refreshes every 15s").font(.caption2).foregroundStyle(Theme.secondary)
            Text("Trains are placed at their reported or next station. Exact positions between stations are unavailable.")
                .font(.caption2).foregroundStyle(Theme.secondary)
            if snapshot?.feedStatus.busVehicles?.configured == false { Text("Bus GPS needs a Bus Time key in Sources.").font(.caption2).foregroundStyle(.orange) }
            else if snapshot?.feedStatus.busVehicles?.stale == true { Text("Bus GPS reports are unavailable or stale.").font(.caption2).foregroundStyle(.orange) }
            if snapshot?.truncated == true { Text("Zoom in to see more vehicles.").font(.caption2).foregroundStyle(Theme.secondary) }
            if let vehicleError { Text(vehicleError).font(.caption2).foregroundStyle(.orange) }
            } else {
                Text("Bus GPS · train station estimates").font(.caption2).foregroundStyle(Theme.secondary)
                if let vehicleError { Text(vehicleError).font(.caption2).foregroundStyle(.orange) }
            }
        }.font(.caption).toggleStyle(.switch).padding(14).frame(width: controlsExpanded ? 235 : 220)
            .background(.regularMaterial, in: .rect(cornerRadius: 16)).padding(12)
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

struct LiveVehicleMapScreen: View {
    let apiBaseURLString: String
    let origin: Place?
    let destination: Place?
    let route: Itinerary?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            JourneyMap(route: route, origin: origin, destination: destination, apiBaseURLString: apiBaseURLString, showsVehicleControls: true)
                .navigationTitle("Live vehicles").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
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
