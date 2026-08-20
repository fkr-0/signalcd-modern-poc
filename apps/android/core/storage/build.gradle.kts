plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ksp)
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
}

dependencies {
    implementation(project(":core:identity"))
    implementation(libs.room.runtime)
    implementation(libs.kotlinx.coroutines.core)

    ksp(libs.room.compiler)

    testImplementation(kotlin("test"))
    testImplementation(libs.sqlite.bundled)
    testImplementation(libs.kotlinx.coroutines.core)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
