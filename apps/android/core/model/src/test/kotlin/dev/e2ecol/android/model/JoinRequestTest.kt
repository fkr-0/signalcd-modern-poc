package dev.e2ecol.android.model

import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class JoinRequestTest {
    @Test
    fun `parses the documented join URI with group and inviter`() {
        val request = JoinRequestParser.parse(
            "e2e-col://join?document=11111111-1111-4111-8111-111111111111" +
                "&group=my-group-42&inviter=%2B15551234567",
        )

        assertEquals(UUID.fromString("11111111-1111-4111-8111-111111111111"), request.documentId)
        assertEquals("my-group-42", request.groupId)
        assertEquals("+15551234567", request.inviter)
    }

    @Test
    fun `rejects unrelated schemes and hosts`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("https://example.com/join?document=11111111-1111-4111-8111-111111111111&group=g1&inviter=+15551234567")
        }
    }

    @Test
    fun `rejects non-canonical UUID spellings`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=1-1-1-1-1&group=g1&inviter=+15551234567")
        }
    }

    @Test
    fun `rejects missing document parameter`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?group=g1&inviter=+15551234567")
        }
    }

    @Test
    fun `rejects missing group parameter`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=11111111-1111-4111-8111-111111111111&inviter=+15551234567")
        }
    }

    @Test
    fun `rejects blank group parameter`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=11111111-1111-4111-8111-111111111111&group=&inviter=+15551234567")
        }
    }

    @Test
    fun `rejects missing inviter parameter`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=11111111-1111-4111-8111-111111111111&group=g1")
        }
    }

    @Test
    fun `rejects invalid inviter phone number`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=11111111-1111-4111-8111-111111111111&group=g1&inviter=not-a-phone")
        }
    }

    @Test
    fun `rejects inviter without leading plus`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=11111111-1111-4111-8111-111111111111&group=g1&inviter=15551234567")
        }
    }

    @Test
    fun `rejects blank document parameter`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=&group=g1&inviter=+15551234567")
        }
    }

    @Test
    fun `rejects blank inviter parameter`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse("e2e-col://join?document=11111111-1111-4111-8111-111111111111&group=g1&inviter=")
        }
    }

    @Test
    fun `rejects duplicate parameters`() {
        assertFailsWith<IllegalArgumentException> {
            JoinRequestParser.parse(
                "e2e-col://join?document=11111111-1111-4111-8111-111111111111" +
                    "&group=g1&inviter=+15551234567&document=22222222-2222-4222-8222-222222222222",
            )
        }
    }

    @Test
    fun `accepts opaque non-blank group ids`() {
        val request = JoinRequestParser.parse(
            "e2e-col://join?document=11111111-1111-4111-8111-111111111111" +
                "&group=team-alpha-2024&inviter=%2B442071234567",
        )
        assertEquals("team-alpha-2024", request.groupId)
        assertEquals("+442071234567", request.inviter)
    }

    @Test
    fun `accepts various valid E164 phone numbers`() {
        val request = JoinRequestParser.parse(
            "e2e-col://join?document=11111111-1111-4111-8111-111111111111" +
                "&group=g1&inviter=%2B442071234567",
        )
        assertEquals("+442071234567", request.inviter)
    }
}
