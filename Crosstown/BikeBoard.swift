import SwiftUI
import MapKit
import CrosstownCore

struct BikeBoard: View {
    let origin: Place?
    @State private var snapshot: BikeSnapshot?
    @State private var loading = false
    @State private var error: String?
    @State private var viewport: MKCoordinateRegion?
    @State private var selectedID: String?
    private let client = CitiBikeClient()

    private var initialRegion: MKCoordinateRegion {
        let near = origin?.coordinate ?? Coordinate(40.7505, -73.9934)
        return MKCoordinateRegion(center: mapPoint(near), span: MKCoordinateSpan(latitudeDelta: 0.024, longitudeDelta: 0.024))
    }

    var body: some View {
        let region = viewport ?? initialRegion
        let visible = snapshot?.stations.filter { station in
            abs(station.coordinate.latitude - region.center.latitude) <= region.span.latitudeDelta * 0.55 &&
            abs(station.coordinate.longitude - region.center.longitude) <= region.span.longitudeDelta * 0.55
        } ?? []
        let selected = snapshot?.stations.first(where: { $0.id == selectedID })
        VStack(spacing: 0) {
            Map(initialPosition: .region(initialRegion), interactionModes: [.pan, .zoom]) {
                ForEach(visible) { station in
                    Annotation(station.name, coordinate: mapPoint(station.coordinate)) {
                        Button { selectedID = station.id } label: {
                            let compact = region.span.longitudeDelta > 0.09
                            Circle().fill(dockColor(station))
                                .frame(width: station.id == selectedID ? 17 : compact ? 7 : 12, height: station.id == selectedID ? 17 : compact ? 7 : 12)
                                .overlay { Circle().strokeBorder(.white, lineWidth: 1.5) }
                                .padding(compact ? 2 : 5)
                        }.buttonStyle(.plain).accessibilityLabel(station.name)
                    }
                }.annotationTitles(.hidden)
            }.id(origin?.id ?? "")
                .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
                .onMapCameraChange(frequency: .onEnd) { viewport = $0.region }
                .frame(minHeight: 230, maxHeight: .infinity)
                .accessibilityLabel("Citi Bike station map")
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(selected?.name ?? "Citi Bike docks").font(.headline).lineLimit(1)
                    Spacer(minLength: 5)
                    Button { Task { await refresh() } } label: {
                        Image(systemName: "arrow.clockwise").frame(width: 40, height: 40)
                    }.disabled(loading).accessibilityLabel("Refresh Citi Bike docks")
                }
                if let selected {
                    Text(counts(selected)).font(.subheadline)
                    Button("‹ Nearby docks") { selectedID = nil }.font(.subheadline)
                } else if let snapshot {
                    Text("\(visible.count) in view · \(snapshot.stations.count) mapped").font(.subheadline)
                    HStack(spacing: 12) {
                        legend("Available", .green)
                        legend("E-bikes only", .purple)
                        legend("No bikes", .red)
                    }
                }
                if let error { Text(error).font(.caption).foregroundStyle(Theme.secondary) }
                else if let snapshot {
                    Text(snapshot.isStale ? "Dock reports are stale." : "Live dock reports · \(snapshot.updatedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(Theme.secondary)
                } else if loading { ProgressView("Checking stations…") }
            }.padding(.horizontal, 18).padding(.vertical, 7).frame(maxWidth: .infinity, alignment: .leading).background(.white)
            if selected == nil {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(nearest(visible, to: region.center)) { station in
                            Button { selectedID = station.id } label: {
                                HStack(spacing: 9) {
                                    Circle().fill(dockColor(station)).frame(width: 10, height: 10)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(station.name).font(.subheadline.weight(.semibold))
                                        Text(counts(station)).font(.caption).foregroundStyle(Theme.secondary)
                                    }
                                    Spacer()
                                }.padding(.vertical, 9)
                            }.buttonStyle(.plain)
                            Divider()
                        }
                    }.padding(.horizontal, 18)
                }.frame(height: 122)
            }
        }
        .task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(45)) } catch { return }
            }
        }
    }

    private func counts(_ station: BikeStation) -> String {
        let bikes = station.isRenting ? "\(station.classicBikes.map(String.init) ?? "?") classic · \(station.ebikes.map(String.init) ?? "?") e-bikes" : "Pickup paused"
        let docks = station.isReturning ? "\(station.docks) open docks" : "Returns paused"
        return "\(bikes) · \(docks)" + (station.isStale ? " · stale report" : "")
    }

    private func dockColor(_ station: BikeStation) -> Color {
        if station.isStale || snapshot?.isStale == true || !station.isRenting { return .gray }
        if station.classicBikes == 0 && (station.ebikes ?? 0) > 0 { return .purple }
        return station.bikes > 0 ? .green : .red
    }

    private func legend(_ title: String, _ color: Color) -> some View {
        Label { Text(title) } icon: { Circle().fill(color).frame(width: 8, height: 8) }
            .font(.caption2)
    }

    private func mapPoint(_ coordinate: Coordinate) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude)
    }

    private func nearest(_ stations: [BikeStation], to center: CLLocationCoordinate2D) -> [BikeStation] {
        let current = CLLocation(latitude: center.latitude, longitude: center.longitude)
        let ranked = stations.map { station in
            (station, current.distance(from: CLLocation(latitude: station.coordinate.latitude, longitude: station.coordinate.longitude)))
        }.sorted { $0.1 < $1.1 }
        return ranked.prefix(8).map { $0.0 }
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await client.stations()
            guard !Task.isCancelled else { return }
            snapshot = result; error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = "Couldn’t refresh station reports."
        }
    }
}
