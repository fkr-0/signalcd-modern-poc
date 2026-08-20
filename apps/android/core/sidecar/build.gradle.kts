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
    implementation(libs.okhttp)
    testImplementation(kotlin("test"))
}
