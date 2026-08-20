package dev.e2ecol.android

import androidx.lifecycle.ViewModel
import dev.e2ecol.android.model.JoinRequestParser
import dev.e2ecol.android.protocol.ProtocolEnvelopeCodec
import dev.e2ecol.android.sidecar.SidecarEndpoint
import dev.e2ecol.android.sidecar.SidecarWebSocketTransport
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

class EditorViewModel : ViewModel() {
    private val mutableState = MutableStateFlow(EditorUiState())
    val state: StateFlow<EditorUiState> = mutableState.asStateFlow()
    private var connection: SidecarWebSocketTransport.Connection? = null

    fun applyJoinLink(raw: String) {
        runCatching { JoinRequestParser.parse(raw) }
            .onSuccess { request ->
                mutableState.update {
                    it.copy(
                        documentId = request.documentId.toString(),
                        groupId = request.groupId,
                        inviter = request.inviter,
                        message = "Join link validated locally",
                    )
                }
            }
            .onFailure { error ->
                mutableState.update { it.copy(message = error.message ?: "Invalid join link") }
            }
    }

    fun setDocumentId(value: String) = mutableState.update { it.copy(documentId = value) }

    fun setSidecarUrl(value: String) = mutableState.update { it.copy(sidecarUrl = value) }

    fun setDraftText(value: String) = mutableState.update { it.copy(draftText = value) }

    fun connect() {
        val current = mutableState.value
        mutableState.update { it.copy(connection = ConnectionState.CONNECTING, message = null) }
        runCatching {
            val documentId = UUID.fromString(current.documentId)
            val endpoint = SidecarEndpoint.create(current.sidecarUrl)
            val transport = SidecarWebSocketTransport(endpoint)
            connection?.close()
            connection = transport.connect(
                documentId,
                object : SidecarWebSocketTransport.Listener {
                    override fun onOpen() {
                        mutableState.update {
                            it.copy(connection = ConnectionState.ONLINE, message = "Sidecar connected")
                        }
                    }

                    override fun onFrame(bytes: ByteArray) {
                        runCatching { ProtocolEnvelopeCodec.decode(bytes) }
                            .onSuccess { envelope ->
                                mutableState.update {
                                    it.copy(
                                        lastFrame = "${envelope.kind.wireName} · ${envelope.messageId}",
                                    )
                                }
                            }
                            .onFailure { error ->
                                mutableState.update {
                                    it.copy(message = "Rejected sidecar frame: ${error.message}")
                                }
                            }
                    }

                    override fun onClosed(code: Int, reason: String) {
                        mutableState.update {
                            it.copy(
                                connection = ConnectionState.OFFLINE,
                                message = "Sidecar closed ($code): $reason",
                            )
                        }
                    }

                    override fun onFailure(error: Throwable) {
                        mutableState.update {
                            it.copy(
                                connection = ConnectionState.OFFLINE,
                                message = error.message ?: "Sidecar connection failed",
                            )
                        }
                    }
                },
            )
        }.onFailure { error ->
            mutableState.update {
                it.copy(
                    connection = ConnectionState.OFFLINE,
                    message = error.message ?: "Invalid sidecar configuration",
                )
            }
        }
    }

    fun disconnect() {
        connection?.close()
        connection = null
        mutableState.update { it.copy(connection = ConnectionState.OFFLINE, message = "Disconnected") }
    }

    override fun onCleared() {
        connection?.close()
        connection = null
    }
}

data class EditorUiState(
    val documentId: String = "11111111-1111-4111-8111-111111111111",
    val groupId: String? = null,
    val inviter: String? = null,
    val sidecarUrl: String = "ws://127.0.0.1:43127",
    val draftText: String = "",
    val connection: ConnectionState = ConnectionState.OFFLINE,
    val lastFrame: String? = null,
    val message: String? = null,
)

enum class ConnectionState {
    OFFLINE,
    CONNECTING,
    ONLINE,
}
