import SwiftUI
import CrosstownCore

struct RouteDetail: View {
    let route: Itinerary
    let alternatives: [Itinerary]
    let onChooseDeparture: (Itinerary) -> Void
    @State var isSaved: Bool
    let onSave: () -> Void
    let onRefresh: () async -> Void
    let apiBaseURLString: String
    @State private var walkthrough = false
    @State private var refreshing = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack { DataPill(); Spacer(); Text("YOUR ITINERARY").font(.system(size: 9, weight: .medium, design: .monospaced)).tracking(1).foregroundStyle(Theme.secondary) }
                    Text(route.title).font(.system(size: 38, weight: .semibold)).tracking(-1.5)
                    Text(route.explanation).font(.subheadline).foregroundStyle(Theme.secondary).lineSpacing(4)
                    Text("Leave \(time(route.departureTime)) · arrive \(time(route.arrivalTime)) · checked \(time(route.generatedAt))")
                        .font(.caption).foregroundStyle(Theme.secondary)
                    Button(refreshing ? "Refreshing predictions…" : "Refresh this trip") {
                        refreshing = true
                        Task { await onRefresh(); refreshing = false }
                    }.disabled(refreshing)
                    HStack(spacing: 0) {
                        metric(route.minutes.minuteText + " min", label: "Total time")
                        metric(route.fareText, label: "Est. cost")
                        metric(route.outdoorMinutes.minuteText + " min", label: "Outside")
                    }.padding(.vertical, 18).background(.white, in: .rect(cornerRadius: 20))
                    JourneyMap(route: route, origin: route.legs.first?.from, destination: route.legs.last?.to, apiBaseURLString: apiBaseURLString).frame(height: 210).clipShape(.rect(cornerRadius: 22))
                    Text("The connection").font(.title3.weight(.semibold))
                    VStack(spacing: 0) {
                        ForEach(Array(route.legs.enumerated()), id: \.element.id) { index, leg in
                            HStack(alignment: .top, spacing: 15) {
                                VStack(spacing: 5) {
                                    Image(systemName: leg.mode.symbol).font(.system(size: 17)).foregroundStyle(Theme.mode(leg.mode)).frame(width: 42, height: 42).background(.white, in: Circle())
                                    if leg.id != route.legs.last?.id { Rectangle().fill(Theme.line).frame(width: 2, height: 48) }
                                }
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack(alignment: .top) {
                                        Text(leg.instruction).font(.system(size: 15, weight: .semibold))
                                        Spacer(minLength: 10)
                                        Text(leg.duration.minuteText + " min").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.secondary)
                                    }
                                    if leg.mode == .subway || leg.mode == .bus {
                                        Text("\(leg.realtime == true ? "Live prediction" : "Scheduled"): depart \(time(leg.departureTime)), arrive \(time(leg.arrivalTime))")
                                            .font(.caption).foregroundStyle(leg.realtime == true ? Theme.green : Theme.secondary)
                                        Text("Board at \(leg.from.name) · \(leg.waitingMinutes.minuteText) min wait after reaching the stop").font(.caption).foregroundStyle(Theme.secondary)
                                        if let report = leg.predictionReportedAt { Text("MTA report \(time(report))").font(.caption2).foregroundStyle(Theme.secondary) }
                                        if leg.mode == .subway {
                                            DisclosureGroup("Choose a train") {
                                                ForEach(departures(for: index)) { option in
                                                    Button { onChooseDeparture(option) } label: {
                                                        HStack {
                                                            VStack(alignment: .leading, spacing: 4) {
                                                                Text("\(option.legs[index].line ?? "Train") · \(time(option.legs[index].departureTime))")
                                                                Text("Arrive \(time(option.arrivalTime)) · \(option.minutes.minuteText) min total").font(.caption).foregroundStyle(Theme.secondary)
                                                            }
                                                            Spacer()
                                                            if option.choiceId == route.choiceId { Image(systemName: "checkmark.circle.fill") }
                                                        }.padding(.vertical, 7)
                                                    }.buttonStyle(.plain).accessibilityLabel("Take \(option.legs[index].line ?? "train") at \(time(option.legs[index].departureTime)), arrive \(time(option.arrivalTime))")
                                                }
                                                if departures(for: index).isEmpty { Text("Refresh this trip for current departures.").font(.caption).foregroundStyle(Theme.secondary) }
                                            }.font(.subheadline).tint(Theme.blue)
                                        }
                                    }
                                    if let pickup = leg.bikePickup, let dropoff = leg.bikeReturn {
                                        let bikes = leg.bikeRideType == "lowAssist" ? "0 classic bikes · \(pickup.ebikes ?? 0) e-bikes" : "\(pickup.classicBikes ?? 0) classic bikes"
                                        Text("\(bikes) at pickup · \(dropoff.docks) return docks now").font(.caption).foregroundStyle(Theme.green)
                                        if leg.bikeRideType == "lowAssist" {
                                            Text("Choose Low Assist in Citi Bike at unlock if offered. Bike counts can change.").font(.caption).foregroundStyle(Theme.secondary)
                                        }
                                    }
                                    if leg.setupMinutes > 0 { Text("About \(max(0, leg.duration-leg.setupMinutes).minuteText) min riding + \(leg.setupMinutes.minuteText) min for pickup and return.").font(.caption).foregroundStyle(Theme.secondary) }
                                    Text(leg.to.name).font(.caption).foregroundStyle(Theme.secondary)
                                    if let steps = leg.steps, !steps.isEmpty {
                                        DisclosureGroup("Street directions") {
                                            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                                                Text("\(step.relativeDirection.replacingOccurrences(of: "_", with: " ").lowercased()) onto \(step.streetName) · \(Int(step.distance.rounded())) m\(step.walkingBike == true ? " · walk bike" : "")").font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3)
                                            }
                                        }.font(.caption).tint(Theme.blue)
                                    }
                                }.padding(.top, 6).padding(.bottom, 26)
                            }
                        }
                    }
                    Text("Street times are estimates. This leg guide does not track your location; refresh if you miss a connection.").font(.caption).foregroundStyle(Theme.secondary)
                }.padding(24)
            }.background(Theme.canvas).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItemGroup(placement: .primaryAction) {
                        ShareLink(item: route.summary) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share itinerary")
                        Button { onSave(); isSaved.toggle() } label: { Image(systemName: isSaved ? "bookmark.fill" : "bookmark") }.accessibilityLabel(isSaved ? "Remove saved route" : "Save route")
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    Button { walkthrough = true } label: { Label("Step-by-step", systemImage: "arrow.right").font(.system(size: 16, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 55) }
                        .buttonStyle(.borderedProminent).buttonBorderShape(.roundedRectangle(radius: 18)).padding(.horizontal, 24).padding(.vertical, 12).background(Theme.canvas)
                }
        }.sheet(isPresented: $walkthrough) { TripWalkthrough(route: route) }.presentationDragIndicator(.visible)
    }
    private func metric(_ value: String, label: String) -> some View {
        VStack(spacing: 5) { Text(value).font(.system(size: 21, weight: .semibold)).minimumScaleFactor(0.7).lineLimit(1); Text(label).font(.system(size: 11)).foregroundStyle(Theme.secondary) }.frame(maxWidth: .infinity)
    }
    private func departures(for index: Int) -> [Itinerary] {
        var seen = Set<String>()
        return alternatives.filter { option in
            guard option.legs.indices.contains(index), option.canChooseDeparture() else { return false }
            for prefix in 0..<index where route.legs[prefix].mode == .subway || route.legs[prefix].mode == .bus {
                if (route.legs[prefix].tripId ?? route.legs[prefix].departureTime) != (option.legs[prefix].tripId ?? option.legs[prefix].departureTime) { return false }
            }
            let leg = option.legs[index]
            return seen.insert(leg.tripId ?? "\(leg.line ?? "")|\(leg.departureTime ?? "")").inserted
        }.sorted { ($0.legs[index].departureTime ?? "") < ($1.legs[index].departureTime ?? "") }
    }
    private func time(_ value: String?) -> String {
        guard let value, let date = ISO8601DateFormatter().date(from: value) ?? ISO8601DateFormatter.fractional.date(from: value) else { return "—" }
        let format = DateFormatter(); format.timeZone = TimeZone(identifier: "America/New_York"); format.dateFormat = "h:mm a"
        return format.string(from: date)
    }
}

private extension ISO8601DateFormatter {
    static var fractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }
}

struct TripWalkthrough: View {
    let route: Itinerary
    @State private var index = 0
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack { DataPill(); Text("TRIP GUIDE").font(.system(size: 10, weight: .bold, design: .monospaced)); Spacer(); Button("Close") { dismiss() } }
            ProgressView(value: Double(index), total: Double(route.legs.count)).tint(Theme.blue)
            Spacer()
            if index < route.legs.count {
                let leg = route.legs[index]
                Image(systemName: leg.mode.symbol).font(.system(size: 65)).foregroundStyle(Theme.mode(leg.mode))
                Text(leg.instruction).font(.system(size: 32, weight: .semibold)).tracking(-1)
                Text("\(leg.duration.minuteText) min · Leg \(index + 1) of \(route.legs.count)").foregroundStyle(Theme.secondary)
                if leg.setupMinutes > 0 { Text("Check live bikes and return docks before you set off.").font(.subheadline) }
            } else {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 65)).foregroundStyle(Theme.green)
                Text("That’s your connection.").font(.largeTitle.weight(.semibold))
                Text("You have marked all legs complete. No location tracking was used.").foregroundStyle(Theme.secondary)
            }
            Spacer()
            Text("Tap as you finish each leg. No location tracking.").font(.caption).foregroundStyle(Theme.secondary)
            Button(index < route.legs.count ? "Mark leg complete" : "Done") {
                if index < route.legs.count { index += 1 } else { dismiss() }
            }.fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 54).buttonStyle(.borderedProminent)
        }.padding(28).background(Theme.canvas)
    }
}
