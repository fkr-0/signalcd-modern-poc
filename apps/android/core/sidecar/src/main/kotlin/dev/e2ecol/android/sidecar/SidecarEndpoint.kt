package dev.e2ecol.android.sidecar

import java.net.URI
import java.util.UUID
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request

class SidecarEndpoint private constructor(
    private val baseUrl: HttpUrl,
) {
    fun request(documentId: UUID): Request =
        Request.Builder()
            .url(
                baseUrl.newBuilder()
                    .setQueryParameter("documentId", documentId.toString())
                    .build(),
            )
            .build()

    override fun toString(): String = baseUrl.toString()

    companion object {
        fun create(rawUrl: String, allowRemote: Boolean = false): SidecarEndpoint {
            val parsed = URI(rawUrl)
            val scheme = parsed.scheme?.lowercase()
            require(scheme in setOf("ws", "wss")) {
                "sidecar URL must use ws or wss"
            }
            require(parsed.rawUserInfo == null) { "sidecar URL must not contain credentials" }
            require(parsed.fragment == null) { "sidecar URL must not contain a fragment" }
            val host = parsed.host ?: throw IllegalArgumentException("sidecar URL requires a host")
            val canonicalHost = host.removePrefix("[").removeSuffix("]").lowercase()
            val loopback = canonicalHost == "localhost" || canonicalHost == "127.0.0.1" || canonicalHost == "::1"
            if (!loopback) {
                require(allowRemote) {
                    "sidecar URL must be loopback unless allowRemote is explicitly enabled"
                }
                require(scheme == "wss") { "remote sidecar URLs must use wss" }
            }
            val normalizedScheme = when (scheme) {
                "ws" -> "http"
                "wss" -> "https"
                else -> error("validated sidecar scheme became unavailable")
            }
            val normalized = URI(
                normalizedScheme,
                null,
                host,
                parsed.port,
                parsed.path.ifEmpty { "/" },
                parsed.query,
                null,
            )
            return SidecarEndpoint(normalized.toString().toHttpUrl())
        }
    }
}
