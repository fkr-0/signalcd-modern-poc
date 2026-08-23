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
    fun `replaces duplicate document parameters with exactly one canonical value`() {
        val request = SidecarEndpoint.create(
            "ws://127.0.0.1:43127/socket?documentId=stale&mode=dev&documentId=older",
        ).request(documentId)
        assertEquals(listOf(documentId.toString()), request.url.queryParameterValues("documentId"))
        assertEquals("dev", request.url.queryParameter("mode"))
    }

    @Test
    fun `accepts documented loopback spellings without weakening remote policy`() {
        val localhost = SidecarEndpoint.create("ws://LOCALHOST:43127").request(documentId)
        assertEquals("localhost", localhost.url.host)

        val ipv6 = SidecarEndpoint.create("ws://[::1]:43127").request(documentId)
        assertEquals("::1", ipv6.url.host)
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

    @Test
    fun `requires tls even when a remote endpoint is explicitly enabled`() {
        assertFailsWith<IllegalArgumentException> {
            SidecarEndpoint.create("ws://relay.example.test/socket", allowRemote = true)
        }
    }

    @Test
    fun `rejects url credentials and non websocket schemes`() {
        assertFailsWith<IllegalArgumentException> {
            SidecarEndpoint.create("ws://user:secret@127.0.0.1:43127")
        }
        assertFailsWith<IllegalArgumentException> {
            SidecarEndpoint.create("http://127.0.0.1:43127")
        }
    }
}
