package dev.e2ecol.android.session

import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.automerge.Document

class AutomergeInteropFixtureTest {
    @Test
    fun `loads and edits TypeScript Automerge snapshot`() {
        val encoded = requireNotNull(javaClass.getResourceAsStream("/ts-automerge-v1.base64"))
            .bufferedReader()
            .use { it.readText().trim() }
        val document = Document.load(Base64.getDecoder().decode(encoded))
        val textId = CanonicalAutomerge.textObjectId(document)

        assertEquals("ts-to-jvm", document.text(textId).orElse(""))

        val tx = document.startTransaction()
        tx.spliceText(textId, 9, 0, " + jvm")
        tx.commit()

        assertEquals("ts-to-jvm + jvm", document.text(textId).orElse(""))
        assertTrue(document.save().isNotEmpty())
    }
}
