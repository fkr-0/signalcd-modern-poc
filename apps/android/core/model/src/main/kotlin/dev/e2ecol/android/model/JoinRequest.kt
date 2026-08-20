package dev.e2ecol.android.model

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.UUID

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

data class JoinRequest(
    val documentId: UUID,
    val groupId: UUID?,
    val inviter: String?,
)

object JoinRequestParser {
    fun parse(raw: String): JoinRequest {
        val uri = URI(raw)
        require(uri.scheme == "e2e-col" && uri.host == "join") {
            "join link must use e2e-col://join"
        }
        val query = parseQuery(uri.rawQuery.orEmpty())
        val document = query["document"] ?: error("join link requires document")
        return JoinRequest(
            documentId = parseUuid(document, "document"),
            groupId = query["group"]?.let { parseUuid(it, "group") },
            inviter = query["inviter"]?.takeIf(String::isNotBlank),
        )
    }

    private fun parseQuery(raw: String): Map<String, String> =
        raw.split('&')
            .filter(String::isNotBlank)
            .associate { part ->
                val pieces = part.split('=', limit = 2)
                decode(pieces[0]) to decode(pieces.getOrElse(1) { "" })
            }

    private fun parseUuid(value: String, field: String): UUID {
        require(UUID_PATTERN.matches(value)) { "$field must be a canonical UUID" }
        return UUID.fromString(value)
    }

    @Suppress("DEPRECATION")
    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
}
