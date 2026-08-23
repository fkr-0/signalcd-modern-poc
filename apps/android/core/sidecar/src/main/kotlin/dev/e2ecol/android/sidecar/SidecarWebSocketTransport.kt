package dev.e2ecol.android.sidecar

import java.util.UUID
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

const val SIDECAR_RECOVERY_CLOSE_CODE = 4409

class SidecarWebSocketTransport private constructor(
    private val endpoint: SidecarEndpoint,
    private val openSocket: (Request, WebSocketListener) -> WebSocket,
) {
    constructor(
        endpoint: SidecarEndpoint,
        client: OkHttpClient = OkHttpClient(),
    ) : this(endpoint, client::newWebSocket)

    internal constructor(
        endpoint: SidecarEndpoint,
        socketFactory: SocketFactory,
    ) : this(endpoint, socketFactory::open)

    internal fun interface SocketFactory {
        fun open(request: Request, listener: WebSocketListener): WebSocket
    }

    interface Listener {
        fun onOpen() {}
        fun onFrame(bytes: ByteArray) {}
        fun onRecoveryRequired(reason: String) {}
        fun onClosed(code: Int, reason: String) {}
        fun onFailure(error: Throwable) {}
    }

    fun connect(documentId: UUID, listener: Listener): Connection {
        val connection = Connection()
        val socket = openSocket(
            endpoint.request(documentId),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (connection.markOnline()) listener.onOpen()
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) =
                    listener.onFrame(bytes.toByteArray())

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connection.markOffline()
                    if (code == SIDECAR_RECOVERY_CLOSE_CODE) {
                        listener.onRecoveryRequired(reason)
                    }
                    listener.onClosed(code, reason)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    connection.markOffline()
                    listener.onFailure(t)
                }
            },
        )
        connection.attach(socket)
        return connection
    }

    class Connection internal constructor() {
        private enum class State { CONNECTING, ONLINE, OFFLINE, CLOSED }

        @Volatile
        private var socket: WebSocket? = null

        @Volatile
        private var state = State.CONNECTING

        val isConnected: Boolean
            get() = state == State.ONLINE

        internal fun attach(socket: WebSocket) {
            this.socket = socket
            if (state == State.CLOSED) socket.close(1000, "client closed")
        }

        internal fun markOnline(): Boolean {
            if (state == State.CLOSED) return false
            state = State.ONLINE
            return true
        }

        internal fun markOffline() {
            if (state != State.CLOSED) state = State.OFFLINE
        }

        fun send(frame: ByteArray): Boolean {
            if (!isConnected) return false
            return socket?.send(ByteString.of(*frame)) ?: false
        }

        fun close(): Boolean {
            if (state == State.CLOSED) return true
            state = State.CLOSED
            return socket?.close(1000, "client closed") ?: true
        }
    }
}
