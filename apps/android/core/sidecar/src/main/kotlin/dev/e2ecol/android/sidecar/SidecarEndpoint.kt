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
            require(parsed.scheme in setOf("ws", "wss", "http", "https")) {
                "sidecar URL must use ws(s) or http(s)"
            }
            val host = parsed.host ?: throw IllegalArgumentException("sidecar URL requires a host")
            if (!allowRemote) {
                require(host == "localhost" || host == "127.0.0.1" || host == "::1") {
                    "sidecar URL must be loopback unless allowRemote is explicitly enabled"
                }
            }
            val normalizedScheme = when (parsed.scheme) {
                "ws" -> "http"
                "wss" -> "https"
                else -> parsed.scheme
            }
            val normalized = URI(
                normalizedScheme,
                parsed.userInfo,
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
