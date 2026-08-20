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
    implementation(libs.room.runtime)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(kotlin("test"))
}
