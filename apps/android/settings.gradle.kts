pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "signalcd-modern-poc-android"

include(":app")
include(":core:model")
include(":core:protocol")
include(":core:sidecar")
include(":core:identity")
include(":core:storage")
include(":core:session")
