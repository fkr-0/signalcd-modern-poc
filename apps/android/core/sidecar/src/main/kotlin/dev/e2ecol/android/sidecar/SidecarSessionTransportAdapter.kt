package dev.e2ecol.android.sidecar

import dev.e2ecol.android.model.SessionTransport

/**
 * Adapter that bridges SidecarWebSocketTransport.Connection to the
 * SessionTransport interface consumed by DocumentSession.
 */
class SidecarSessionTransportAdapter(
    private val connection: SidecarWebSocketTransport.Connection,
) : SessionTransport {
    override fun send(frame: ByteArray): Boolean = connection.send(frame)
    override fun close(): Boolean = connection.close()
    override val isConnected: Boolean = true
}
