package dev.e2ecol.android.session

import org.automerge.AmValue
import org.automerge.Document
import org.automerge.ObjectId

/**
 * Cross-runtime canonical Automerge bootstrap shared with @e2e-col/core.
 *
 * The bytes are the result of Automerge 3.4.1 creating actor
 * 00000000000000000000000000000001, then committing `{ text: "" }` at time 0.
 * Keeping this history byte-identical means an incremental text change authored by
 * TypeScript and one authored by the JVM reference the same initial text object.
 */
internal object CanonicalAutomerge {
    private const val EMPTY_DOCUMENT_HEX =
        "856f4a83dcba2dca006e011000000000000000000000000000000001012b8ed0" +
            "6a3487adb4c4790526c78bf6f352770f19b8318c05a75ea9a1a214afe9060102" +
            "03021302230240025602071506210223023401420256028001027f007f017f017f" +
            "007f007f077f04746578747f007f01017f047f007f0000"

    fun emptyDocument(): Document = Document.load(decodeHex(EMPTY_DOCUMENT_HEX))

    fun textObjectId(document: Document): ObjectId {
        val value = document.get(ObjectId.ROOT, "text")
        require(value.isPresent) { "Automerge document is missing canonical 'text' object" }
        return (value.get() as? AmValue.Text)?.id
            ?: error("Automerge document canonical 'text' value is not text")
    }

    private fun decodeHex(value: String): ByteArray =
        ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
}
