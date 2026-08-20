package dev.e2ecol.android.model

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.UUID

private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
private val E164_PATTERN = Regex("^\\+[1-9]\\d{6,14}$")

data class JoinRequest(
    val documentId: UUID,
    val groupId: String,
    val inviter: String,
)

object JoinRequestParser {
    fun parse(raw: String): JoinRequest {
        val uri = try {
            URI(raw)
        } catch (e: Exception) {
            throw IllegalArgumentException("malformed join link URI", e)
        }
        require(uri.scheme == "e2e-col" && uri.host == "join") {
            "join link must use e2e-col://join"
        }
        val query = parseQuery(uri.rawQuery.orEmpty())

        // Reject unknown required-level params gracefully
        val knownParams = setOf("document", "group", "inviter")
        val unknown = query.keys - knownParams
        if (unknown.isNotEmpty()) {
            throw IllegalArgumentException("unknown join link parameters: ${unknown.joinToString()}")
        }

        val document = query["document"]
            ?: throw IllegalArgumentException("join link requires document")
        require(document.isNotBlank()) { "document must not be blank" }

        val group = query["group"]
            ?: throw IllegalArgumentException("join link requires group")
        require(group.isNotBlank()) { "group must not be blank" }

        val inviter = query["inviter"]
            ?: throw IllegalArgumentException("join link requires inviter")
        require(inviter.isNotBlank()) { "inviter must not be blank" }
        require(E164_PATTERN.matches(inviter)) {
            "inviter must be a valid E.164 phone number (e.g. +15551234567)"
        }

        return JoinRequest(
            documentId = parseUuid(document, "document"),
            groupId = group,
            inviter = inviter,
        )
    }

    private fun parseQuery(raw: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        raw.split('&')
            .filter(String::isNotBlank)
            .forEach { part ->
                val pieces = part.split('=', limit = 2)
                val key = decode(pieces[0])
                val value = decode(pieces.getOrElse(1) { "" })
                if (result.containsKey(key)) {
                    throw IllegalArgumentException("duplicate parameter: $key")
                }
                result[key] = value
            }
        return result
    }

    private fun parseUuid(value: String, field: String): UUID {
        require(UUID_PATTERN.matches(value)) { "$field must be a canonical UUID" }
        return try {
            UUID.fromString(value)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("$field must be a canonical UUID")
        }
    }

    @Suppress("DEPRECATION")
    private fun decode(value: String): String =
        try {
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("malformed percent encoding in join link")
        }
}
