import SwiftUI
import CrosstownCore

struct RouteDetail: View {
    let route: Itinerary
    let alternatives: [Itinerary]
    let onChooseDeparture: (Itinerary) -> Void
    @State var isSaved: Bool
    let onSave: () -> Void
    let onRefresh: () async -> Void
    @State private var walkthrough = false
    @State private var refreshing = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                JourneyMap(route: route, origin: route.legs.first?.from, destination: route.legs.last?.to)
                    .frame(height: 190)
                    .accessibilityLabel("Map of the selected route")
                ScrollView {
                    VStack(alignment: .leading, spacing: 13) {
                        summary
                        if let first = route.legs.first {
                            endpoint("Start", name: first.from.name, timestamp: route.departureTime)
                        }
                        VStack(spacing: 0) {
                            ForEach(Array(route.legs.enumerated()), id: \.offset) { index, leg in
                                journeyLeg(leg, at: index)
                            }
                        }
                        if let last = route.legs.last {
                            endpoint("Destination", name: last.to.name, timestamp: route.arrivalTime)
                        }
                        Text("Checked \(time(route.generatedAt))").font(.caption).foregroundStyle(Theme.secondary)
                    }.padding(18)
                }
            }
            .background(.white)
            .navigationTitle("Route overview").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        refreshing = true
                        Task { await onRefresh(); refreshing = false }
                    } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(refreshing).accessibilityLabel("Refresh this trip")
                    ShareLink(item: route.summary) { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("Share itinerary")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack(spacing: 10) {
                    Button { walkthrough = true } label: { Label("Step-by-step", systemImage: "arrow.right") }
                        .buttonStyle(.borderedProminent).tint(Theme.green)
                    Button { onSave(); isSaved.toggle() } label: {
                        Label(isSaved ? "Saved" : "Save", systemImage: isSaved ? "bookmark.fill" : "bookmark")
                    }.buttonStyle(.bordered).tint(Theme.green)
                    Spacer(minLength: 0)
                }.controlSize(.large).padding(.horizontal, 18).padding(.vertical, 8)
                    .frame(maxWidth: .infinity).background(.regularMaterial)
            }
        }.sheet(isPresented: $walkthrough) { TripWalkthrough(route: route) }.presentationDragIndicator(.visible)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(route.minutes.minuteText + " min").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            Text("Arrive \(time(route.arrivalTime)) · \(route.fareText) est. · \(route.outdoorMinutes.minuteText) min outside")
                .font(.subheadline).foregroundStyle(Theme.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    ForEach(Array(route.legs.enumerated()), id: \.offset) { index, leg in
                        if index > 0 {
                            Image(systemName: "chevron.right").font(.caption2.bold()).foregroundStyle(Theme.secondary)
                        }
                        HStack(spacing: 4) {
                            if let line = leg.line { serviceBadge(leg, line: line) }
                            else { Label(leg.duration.minuteText + " min", systemImage: leg.mode.symbol).font(.caption.bold()) }
                        }.padding(4).background(Theme.canvas, in: .rect(cornerRadius: 7))
                    }
                }
            }.accessibilityLabel(route.title)
        }
    }

    private func endpoint(_ label: String, name: String, timestamp: String?) -> some View {
        HStack(spacing: 11) {
            Image(systemName: "smallcircle.filled.circle").font(.title3).foregroundStyle(Theme.green)
                .frame(width: 29).accessibilityHidden(true)
            timelineStop(label, name: name, timestamp: timestamp)
        }
    }

    private func timelineStop(_ label: String, name: String, timestamp: String?) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.caption).foregroundStyle(Theme.secondary)
                Text(name).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 5)
            Text(time(timestamp)).font(.caption.weight(.semibold)).monospacedDigit().fixedSize()
        }
    }

    private func legColor(_ leg: RouteLeg) -> Color {
        if let line = leg.line, leg.mode == .subway { return SubwayBadge.color(line, reported: leg.routeColor) }
        return Theme.mode(leg.mode)
    }

    @ViewBuilder private func serviceBadge(_ leg: RouteLeg, line: String) -> some View {
        if leg.mode == .subway {
            SubwayBadge(line: line, reportedColor: leg.routeColor, size: 20)
        } else {
            Text(line).font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 3)
                .background(legColor(leg), in: .rect(cornerRadius: 5)).foregroundStyle(.white)
        }
    }

    private func journeyLeg(_ leg: RouteLeg, at index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if leg.mode == .subway || leg.mode == .bus {
                transitLeg(leg, at: index)
            } else {
                streetLeg(leg)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 11)
            .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
            .padding(.leading, 40)
            .overlay(alignment: .leading) {
                Color.clear.frame(width: 30)
                .overlay {
                    if leg.mode == .walk {
                        Canvas { context, size in
                            for y in stride(from: 5.0, to: size.height, by: 11.0) {
                                let dot = CGRect(x: size.width / 2 - 2.5, y: y, width: 5, height: 5)
                                context.fill(Path(ellipseIn: dot), with: .color(Theme.secondary.opacity(0.7)))
                            }
                        }
                    } else {
                        Capsule().fill(legColor(leg)).frame(width: 5)
                    }
                }
                .overlay(alignment: .top) {
                    Image(systemName: leg.mode.symbol).font(.caption.bold()).foregroundStyle(legColor(leg))
                        .frame(width: 27, height: 27).background(.white, in: .rect(cornerRadius: 8))
                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.line) }.padding(.top, 9)
                }.accessibilityHidden(true)
            }
    }

    @ViewBuilder private func transitLeg(_ leg: RouteLeg, at index: Int) -> some View {
        let runtime = max(0, leg.duration - leg.waitingMinutes).minuteText + " min ride"
        timelineStop("Board at", name: leg.from.name, timestamp: leg.departureTime)
        HStack(spacing: 6) {
            if let line = leg.line { serviceBadge(leg, line: line) }
            Text(leg.headsign.map { "Toward \($0)" } ?? runtime).font(.subheadline)
        }
        Text((leg.realtime == true ? "Live departure" : "Scheduled departure")
             + (leg.waitingMinutes >= 1 ? " · \(leg.waitingMinutes.minuteText) min wait" : ""))
            .font(.caption).foregroundStyle(leg.realtime == true ? Theme.green : Theme.secondary)
        if leg.mode == .subway {
            let options = departures(for: index)
            if !options.isEmpty {
                DisclosureGroup("Choose a train") {
                    ForEach(options) { option in
                        Button { onChooseDeparture(option) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("\(option.legs[index].line ?? "Train") · \(time(option.legs[index].departureTime))")
                                    Text("Arrive \(time(option.arrivalTime)) · \(option.minutes.minuteText) min total")
                                        .font(.caption).foregroundStyle(Theme.secondary)
                                }
                                Spacer()
                                if option.choiceId == route.choiceId { Image(systemName: "checkmark.circle.fill") }
                            }.padding(.vertical, 6)
                        }.buttonStyle(.plain)
                    }
                }.font(.subheadline)
            }
        }
        if let count = leg.stopCount {
            let label = "\(count) \(count == 1 ? "stop" : "stops") · \(runtime)"
            if let stops = leg.intermediateStops, !stops.isEmpty {
                DisclosureGroup(label) {
                    ForEach(Array(stops.enumerated()), id: \.offset) { _, stop in
                        Label(stop.name, systemImage: "circle").font(.caption)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                    }
                }.font(.subheadline)
            } else {
                Text(label).font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        timelineStop("Get off at", name: leg.to.name, timestamp: leg.arrivalTime)
    }

    @ViewBuilder private func streetLeg(_ leg: RouteLeg) -> some View {
        let distance = leg.distanceMeters.flatMap { $0 >= 80 ? ($0 / 1609.344).formatted(.number.precision(.fractionLength(1))) + " mi" : nil }
        Text([leg.duration.minuteText + " min", distance].compactMap { $0 }.joined(separator: " · "))
            .font(.caption).foregroundStyle(Theme.secondary)
        Text(leg.instruction).font(.subheadline.weight(.semibold))
        if let pickup = leg.bikePickup, let dropoff = leg.bikeReturn {
            let bikes = leg.bikeRideType == "lowAssist" ? "0 classic bikes · \(pickup.ebikes ?? 0) e-bikes" : "\(pickup.classicBikes ?? 0) classic bikes"
            Text("\(bikes) · \(dropoff.docks) return docks when checked").font(.caption).foregroundStyle(Theme.green)
            if leg.bikeRideType == "lowAssist" {
                Text("Choose Low Assist at unlock if Citi Bike offers it.").font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        if leg.setupMinutes > 0 {
            Text("Includes \(leg.setupMinutes.minuteText) min for pickup and return.").font(.caption).foregroundStyle(Theme.secondary)
        }
        if let steps = leg.steps, !steps.isEmpty {
            DisclosureGroup("Street directions") {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    Text("\(step.relativeDirection.replacingOccurrences(of: "_", with: " ").lowercased()) onto \(step.streetName) · \(Int(step.distance.rounded())) m\(step.walkingBike == true ? " · walk bike" : "")")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3)
                }
            }.font(.subheadline)
        }
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
