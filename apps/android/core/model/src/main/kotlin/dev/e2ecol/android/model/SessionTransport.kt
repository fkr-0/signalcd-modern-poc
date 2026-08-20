package dev.e2ecol.android.model

/**
 * Transport abstraction for sending frames over a sidecar connection.
 * Compatible with SidecarWebSocketTransport.Connection.
 */
interface SessionTransport {
    fun send(frame: ByteArray): Boolean
    fun close(): Boolean
    val isConnected: Boolean
}
