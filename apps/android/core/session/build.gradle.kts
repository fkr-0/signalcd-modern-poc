plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
}

dependencies {
    implementation(project(":core:model"))
    implementation(project(":core:protocol"))
    implementation(project(":core:storage"))
    implementation(project(":core:sidecar"))
    implementation(libs.automerge)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.room.runtime)

    testImplementation(kotlin("test"))
    testImplementation(libs.sqlite.bundled)
    testImplementation(libs.kotlinx.coroutines.core)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
