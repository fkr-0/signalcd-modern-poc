package dev.e2ecol.android.sidecar

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

class SidecarWebSocketTransportTest {
    private val documentId = UUID.fromString("11111111-1111-4111-8111-111111111111")

    @Test
    fun `connection becomes usable only after open and carries binary frames`() {
        val harness = SocketHarness()
        val received = mutableListOf<ByteArray>()
        var opened = 0
        val transport = SidecarWebSocketTransport(
            SidecarEndpoint.create("ws://127.0.0.1:43127"),
            harness,
        )
        val connection = transport.connect(
            documentId,
            object : SidecarWebSocketTransport.Listener {
                override fun onOpen() {
                    opened += 1
                }

                override fun onFrame(bytes: ByteArray) {
                    received += bytes
                }
            },
        )

        assertFalse(connection.isConnected)
        assertFalse(connection.send(byteArrayOf(1, 2, 3)))
        assertEquals(documentId.toString(), harness.request.url.queryParameter("documentId"))

        harness.open()
        assertTrue(connection.isConnected)
        assertEquals(1, opened)
        assertTrue(connection.send(byteArrayOf(1, 2, 3)))
        assertContentEquals(byteArrayOf(1, 2, 3), harness.socket.binarySent.single())

        harness.binary(byteArrayOf(7, 8, 9))
        assertContentEquals(byteArrayOf(7, 8, 9), received.single())
        harness.closed(1001, "ordinary restart")
        assertFalse(connection.isConnected)
        assertFalse(connection.send(byteArrayOf(4)))
    }

    @Test
    fun `only close code 4409 raises explicit sidecar recovery evidence`() {
        val ordinary = SocketHarness()
        val ordinaryRecovery = mutableListOf<String>()
        val ordinaryConnection = SidecarWebSocketTransport(
            SidecarEndpoint.create("ws://127.0.0.1:43127"),
            ordinary,
        ).connect(
            documentId,
            object : SidecarWebSocketTransport.Listener {
                override fun onRecoveryRequired(reason: String) {
                    ordinaryRecovery += reason
                }
            },
        )
        ordinary.open()
        ordinary.closed(1011, "signal-cli send outcome unavailable")
        assertFalse(ordinaryConnection.isConnected)
        assertEquals(emptyList(), ordinaryRecovery)

        val historyRisk = SocketHarness()
        val recovery = mutableListOf<String>()
        val closed = mutableListOf<Pair<Int, String>>()
        SidecarWebSocketTransport(
            SidecarEndpoint.create("ws://127.0.0.1:43127"),
            historyRisk,
        ).connect(
            documentId,
            object : SidecarWebSocketTransport.Listener {
                override fun onRecoveryRequired(reason: String) {
                    recovery += reason
                }

                override fun onClosed(code: Int, reason: String) {
                    closed += code to reason
                }
            },
        )
        historyRisk.open()
        historyRisk.closed(SIDECAR_RECOVERY_CLOSE_CODE, "backend proved transport history risk")
        assertEquals(listOf("backend proved transport history risk"), recovery)
        assertEquals(
            listOf(SIDECAR_RECOVERY_CLOSE_CODE to "backend proved transport history risk"),
            closed,
        )
    }

    @Test
    fun `explicit close is idempotent and prevents later callbacks from restoring online state`() {
        val harness = SocketHarness()
        var opened = 0
        val connection = SidecarWebSocketTransport(
            SidecarEndpoint.create("ws://127.0.0.1:43127"),
            harness,
        ).connect(
            documentId,
            object : SidecarWebSocketTransport.Listener {
                override fun onOpen() {
                    opened += 1
                }
            },
        )

        assertTrue(connection.close())
        assertTrue(connection.close())
        harness.open()
        assertFalse(connection.isConnected)
        assertEquals(0, opened)
        assertEquals(listOf(1000 to "client closed"), harness.socket.closes)
    }

    private class SocketHarness : SidecarWebSocketTransport.SocketFactory {
        lateinit var request: Request
        lateinit var listener: WebSocketListener
        lateinit var socket: FakeWebSocket

        override fun open(request: Request, listener: WebSocketListener): WebSocket {
            this.request = request
            this.listener = listener
            socket = FakeWebSocket(request)
            return socket
        }

        fun open() {
            listener.onOpen(socket, response(101, "Switching Protocols"))
        }

        fun binary(bytes: ByteArray) {
            listener.onMessage(socket, ByteString.of(*bytes))
        }

        fun closed(code: Int, reason: String) {
            listener.onClosed(socket, code, reason)
        }

        private fun response(code: Int, message: String): Response =
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message(message)
                .build()
    }

    private class FakeWebSocket(private val originalRequest: Request) : WebSocket {
        val binarySent = mutableListOf<ByteArray>()
        val closes = mutableListOf<Pair<Int, String>>()

        override fun request(): Request = originalRequest

        override fun queueSize(): Long = 0

        override fun send(text: String): Boolean = false

        override fun send(bytes: ByteString): Boolean {
            binarySent += bytes.toByteArray()
            return true
        }

        override fun close(code: Int, reason: String?): Boolean {
            closes += code to (reason ?: "")
            return true
        }

        override fun cancel() = Unit
    }
}
