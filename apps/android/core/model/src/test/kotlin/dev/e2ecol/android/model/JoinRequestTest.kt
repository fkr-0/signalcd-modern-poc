package dev.e2ecol.android.model

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class JoinRequestTest {
    @Test
    fun `parses the documented join URI`() {
        val request = JoinRequestParser.parse(
            "e2e-col://join?document=11111111-1111-4111-8111-111111111111" +
                "&group=22222222-2222-4222-8222-222222222222&inviter=Alice%20A",
        )

        assertEquals(UUID.fromString("11111111-1111-4111-8111-111111111111"), request.documentId)
        assertEquals(UUID.fromString("22222222-2222-4222-8222-222222222222"), request.groupId)
        assertEquals("Alice A", request.inviter)
    }

    @Test
    fun `rejects unrelated schemes and hosts`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("https://example.com/join?document=11111111-1111-4111-8111-111111111111")
        }
    }

    @Test
    fun `rejects non-canonical UUID spellings`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=1-1-1-1-1")
        }
    }
}
