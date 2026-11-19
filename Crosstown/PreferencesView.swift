import SwiftUI
import CrosstownCore

struct PreferencesView: View {
    @State var preferences: RoutePreferences
    let onApply: (RoutePreferences) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("A route that feels like you.").font(.system(size: 28, weight: .semibold)).tracking(-1).listRowBackground(Color.clear)
                }
                Section("Your wheels, today") {
                    Picker("Bike", selection: $preferences.bikeSource) {
                        Text("Citi Bike").tag(BikeSource.citiBike)
                        Text("My own bike").tag(BikeSource.ownBike)
                    }.pickerStyle(.segmented)
                    if preferences.bikeSource == .citiBike { Toggle("Annual Citi Bike member", isOn: $preferences.citiBikeMember) }
                    else { Text("Your bike stays with you on walks and subway rides. Buses are excluded. Check the MTA’s carry rules and avoid crowded trains.").font(.footnote).foregroundStyle(Theme.secondary) }
                }
                Section("Open to taking") {
                    ForEach([TravelMode.bike, .subway, .bus], id: \.self) { mode in
                        Toggle(isOn: Binding(get: { preferences.modes.contains(mode) }, set: { enabled in
                            preferences.modes.removeAll { $0 == mode }
                            if enabled { preferences.modes.append(mode) }
                        })) { Label(mode == .bike && preferences.bikeSource == .ownBike ? "My bike" : mode.title, systemImage: mode.symbol) }
                        .disabled(mode == .bus && preferences.bikeSource == .ownBike)
                    }
                    Text("Walking connects your rides.").font(.footnote).foregroundStyle(Theme.secondary)
                    Toggle("Live transit predictions only", isOn: $preferences.requireLiveTransit)
                    Text("Live bus predictions need a Bus Time key on your route server. Turn off live-only to compare bus schedules, labeled as scheduled.").font(.footnote).foregroundStyle(Theme.secondary)
                }
                Section("Keep it within") {
                    Picker("Walking pace", selection: Binding(get: { preferences.walkingPace ?? .brisk }, set: { preferences.walkingPace = $0 })) {
                        ForEach(WalkingPace.allCases, id: \.self) { pace in Text(pace.title).tag(pace) }
                    }
                    Stepper("Budget: \((Double(preferences.maxFareCents) / 100).formatted(.currency(code: "USD")))", value: $preferences.maxFareCents, in: 0...3000, step: 300)
                    Stepper("Walking: \(preferences.maxWalkingMinutes.minuteText) min total", value: $preferences.maxWalkingMinutes, in: 0...90, step: 5)
                    Stepper("Biking: \(preferences.maxBikingMinutes.minuteText) min total", value: $preferences.maxBikingMinutes, in: 0...90, step: 5)
                    Stepper("Transit transfers: \(preferences.maxTransfers)", value: $preferences.maxTransfers, in: 0...3)
                }
                Section {
                    Toggle("Use my own mix", isOn: Binding(get: { preferences.priority == .custom }, set: { preferences.priority = $0 ? .custom : .fastest }))
                    if preferences.priority == .custom {
                        weight("Save time", value: $preferences.timeWeight)
                        weight("Save money", value: $preferences.costWeight)
                        weight("Less time outside", value: $preferences.outsideWeight)
                        weight("Less underground", value: $preferences.undergroundWeight)
                    }
                } header: { Text("Fine-tune the tradeoffs") } footer: { Text("Higher values give that preference more influence. Hard limits always apply. Fares are estimates, not quotes.") }
                Section { Button("Reset preferences") { preferences = .init() }.foregroundStyle(Theme.secondary) }
            }.scrollContentBackground(.hidden).background(Theme.canvas)
                .navigationTitle("Make it mine").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Apply") { onApply(preferences); dismiss() }.fontWeight(.semibold) }
                }
        }.presentationDragIndicator(.visible)
    }
    private func weight(_ label: String, value: Binding<Double>) -> some View {
        VStack(alignment: .leading) {
            HStack { Text(label).font(.subheadline); Spacer(); Text(value.wrappedValue.minuteText).font(.caption.monospacedDigit()).foregroundStyle(Theme.secondary) }
            Slider(value: value, in: 0...100, step: 5).accessibilityLabel(label + " importance")
        }
    }
}
