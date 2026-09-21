// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CatCheck",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .executable(name: "CatCheck", targets: ["CatCheck"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "CatCheck",
            dependencies: [],
            path: "WebSources",
            resources: [
                .copy("Resources/www")
            ]
        )
    ]
)