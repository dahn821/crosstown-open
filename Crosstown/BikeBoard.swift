import SwiftUI
import MapKit
import CrosstownCore

struct BikeBoard: View {
    let origin: Place?
    let onChooseStart: () -> Void
    @State private var snapshot: BikeSnapshot?
    @State private var loading = false
    @State private var error: String?
    private let client = CitiBikeClient()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Find your wheels.").font(.system(size: 31, weight: .semibold)).tracking(-1.2)
                        Text(origin.map { "Near \($0.name)" } ?? "Choose a start to see nearby bikes").font(.subheadline).foregroundStyle(Theme.secondary)
                    }
                    Spacer()
                    Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44).background(.white, in: Circle()) }.disabled(loading || origin == nil).accessibilityLabel("Refresh live bike availability")
                }
                if origin == nil { Button("Choose a start", action: onChooseStart).buttonStyle(.borderedProminent) }
                Text("Live Citi Bike station reports. Counts include different bike types and can change before you arrive. Route search checks availability separately.").font(.subheadline).foregroundStyle(Theme.secondary).lineSpacing(4)
                if loading { ProgressView("Checking stations…").frame(maxWidth: .infinity).padding() }
                if let error { Label(error, systemImage: "wifi.exclamationmark").font(.subheadline).foregroundStyle(Theme.secondary).padding().background(.white, in: .rect(cornerRadius: 16)) }
                if let snapshot {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        VStack(alignment: .leading, spacing: 12) {
                            Text("\(snapshot.isStale ? "STALE FEED" : "LIVE FEED") · Updated \(snapshot.updatedAt.formatted(date: .omitted, time: .shortened))")
                                .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(0.8).foregroundStyle(snapshot.isStale ? .orange : Theme.green)
                            ForEach(snapshot.stations) { station in
                                VStack(alignment: .leading, spacing: 14) {
                                    HStack {
                                        Text(station.name).font(.system(size: 16, weight: .semibold))
                                        Spacer()
                                        Text("\(Int(station.metersAway)) m").font(.caption).foregroundStyle(Theme.secondary)
                                    }
                                    HStack(spacing: 20) {
                                        Label(station.isRenting ? "\(station.bikes) bikes" : "Pickup paused", systemImage: "bicycle")
                                        Label(station.isReturning ? "\(station.docks) docks" : "Returns paused", systemImage: "parkingsign.circle")
                                    }.font(.subheadline).foregroundStyle(Theme.blue)
                                    if station.isStale || snapshot.isStale || error != nil {
                                        Text("Stale or unavailable report. Refresh before relying on these counts.").font(.caption).foregroundStyle(.orange)
                                    }
                                    Button("View station in Maps ↗") {
                                        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: station.coordinate.latitude, longitude: station.coordinate.longitude)))
                                        item.name = station.name; item.openInMaps()
                                    }.font(.caption)
                                }.padding(19).background(.white, in: .rect(cornerRadius: 20))
                            }
                            if snapshot.stations.isEmpty { Text("No station reports within 5 km. Try refreshing.").foregroundStyle(Theme.secondary) }
                            Text("Source: Citi Bike GBFS · Retrieved \(snapshot.fetchedAt.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(Theme.secondary)
                        }.id(context.date.timeIntervalSince1970 / 30)
                    }
                }
            }.padding(24)
        }.refreshable { await refresh() }.task(id: origin) { snapshot = nil; await refresh() }
    }
    private func refresh() async {
        guard let origin else { snapshot = nil; error = nil; loading = false; return }
        loading = true
        do {
            let result = try await client.nearby(origin.coordinate)
            guard !Task.isCancelled else { return }
            snapshot = result; error = nil
        }
        catch {
            guard !Task.isCancelled else { return }
            self.error = "Couldn’t refresh station reports. Check your connection and try again."
        }
        loading = false
    }
}
