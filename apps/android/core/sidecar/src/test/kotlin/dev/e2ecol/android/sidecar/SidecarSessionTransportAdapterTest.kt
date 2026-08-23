package dev.e2ecol.android.sidecar

import dev.e2ecol.android.model.SessionTransport
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SidecarSessionTransportAdapterContractTest {
    @Test
    fun `SidecarSessionTransportAdapter implements SessionTransport`() {
        // Verify the adapter class exists and implements the correct interface
        // Full integration testing requires a real WebSocket connection
        assertTrue(SessionTransport::class.java.isAssignableFrom(SidecarSessionTransportAdapter::class.java))
    }

    @Test
    fun `adapter reflects live connection state instead of assuming connectivity`() {
        val connection = SidecarWebSocketTransport.Connection()
        val adapter = SidecarSessionTransportAdapter(connection)

        assertFalse(adapter.isConnected)
        connection.markOnline()
        assertTrue(adapter.isConnected)
        connection.markOffline()
        assertFalse(adapter.isConnected)
        adapter.close()
        connection.markOnline()
        assertFalse(adapter.isConnected)
    }
}
