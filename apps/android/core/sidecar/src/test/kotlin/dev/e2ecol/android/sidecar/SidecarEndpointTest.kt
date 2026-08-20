package dev.e2ecol.android.sidecar

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class SidecarEndpointTest {
    private val documentId = UUID.fromString("11111111-1111-4111-8111-111111111111")

    @Test
    fun `maps documented websocket endpoint to an OkHttp upgrade request`() {
        val request = SidecarEndpoint.create("ws://127.0.0.1:43127").request(documentId)
        assertEquals("http://127.0.0.1:43127/?documentId=$documentId", request.url.toString())
        assertEquals(null, request.header("Authorization"))
    }

    @Test
    fun `rejects non-loopback endpoints by default`() {
        assertFailsWith<IllegalArgumentException> {
            SidecarEndpoint.create("wss://relay.example.test")
        }
    }

    @Test
    fun `allows explicitly opted-in remote sidecars`() {
        val request = SidecarEndpoint.create(
            "wss://relay.example.test/socket",
            allowRemote = true,
        ).request(documentId)
        assertEquals(
            "https://relay.example.test/socket?documentId=$documentId",
            request.url.toString(),
        )
    }
}
