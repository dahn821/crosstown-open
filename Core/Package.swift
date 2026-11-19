// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CrosstownCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CrosstownCore", targets: ["CrosstownCore"]),
        .executable(name: "crosstown-plan", targets: ["PlannerCLI"])
    ],
    targets: [
        .target(name: "CrosstownCore"),
        .executableTarget(name: "PlannerCLI", dependencies: ["CrosstownCore"]),
        .testTarget(name: "CrosstownCoreTests", dependencies: ["CrosstownCore"], resources: [.copy("Fixtures")])
    ]
)
