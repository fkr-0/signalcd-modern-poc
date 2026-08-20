package dev.e2ecol.android.sidecar

import java.util.UUID
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

class SidecarWebSocketTransport(
    private val endpoint: SidecarEndpoint,
    private val client: OkHttpClient = OkHttpClient(),
) {
    interface Listener {
        fun onOpen() {}
        fun onFrame(bytes: ByteArray) {}
        fun onClosed(code: Int, reason: String) {}
        fun onFailure(error: Throwable) {}
    }

    fun connect(documentId: UUID, listener: Listener): Connection {
        val socket = client.newWebSocket(
            endpoint.request(documentId),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) =
                    listener.onFrame(bytes.toByteArray())

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                    listener.onClosed(code, reason)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                    listener.onFailure(t)
            },
        )
        return Connection(socket)
    }

    class Connection internal constructor(private val socket: WebSocket) {
        fun send(frame: ByteArray): Boolean = socket.send(ByteString.of(*frame))

        fun close(): Boolean = socket.close(1000, "client closed")
    }
}
